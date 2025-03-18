import type { Request, Response } from "express";
import {
  PrismaClient,
  VendorBookingStatus,
  VendorBookingTransactionType,
  LongDistanceServiceType,
  TransactionStatus,
  CancelledBy,
} from "@prisma/client";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

// Define the rates with proper type
const VENDOR_RATES: Record<LongDistanceServiceType, Record<string, any>> = {
  OUTSTATION: {
    mini: { base: 14, short: 17 },
    sedan: { base: 17, short: 22 },
    ertiga: { base: 21, short: 27 },
    innova: { base: 27, short: 30 },
    tempo_12: { fixed: 14700, extra: 26 },
    tempo_16: { fixed: 16700, extra: 29 },
    tempo_20: { fixed: 18700, extra: 33 },
    tempo_26: { fixed: 20700, extra: 38 },
  },
  HILL_STATION: {
    mini: { base: 23 },
    sedan: { base: 30 },
    ertiga: { base: 33 },
    innova: { base: 38 },
    tempo_12: { fixed: 7700, extra: 26 },
    tempo_16: { fixed: 8700, extra: 29 },
    tempo_20: { fixed: 9700, extra: 33 },
    tempo_26: { fixed: 10700, extra: 38 },
  },
  ALL_INDIA_TOUR: {
    mini: { perDay: 3450, extraKm: 17 },
    sedan: { perDay: 4200, extraKm: 19 },
    ertiga: { perDay: 5200, extraKm: 19 },
    innova: { perDay: 6700, extraKm: 21 },
    tempo_12: { perDay: 7700, extraKm: 23 },
    tempo_16: { perDay: 8700, extraKm: 25 },
    tempo_20: { perDay: 9700, extraKm: 27 },
    tempo_26: { perDay: 10700, extraKm: 29 },
  },
  CHARDHAM_YATRA: {
    mini: { base: 28 },
    sedan: { base: 33 },
    ertiga: { base: 38 },
    innova: { base: 43 },
    tempo_12: { fixed: 8700, extra: 28 },
    tempo_16: { fixed: 9700, extra: 31 },
    tempo_20: { fixed: 10700, extra: 35 },
    tempo_26: { fixed: 11700, extra: 40 },
  },
};

// Helper function to create app wallet transaction
async function createAppWalletTransaction(
  amount: number,
  description: string,
  metadata: any
) {
  const appWallet = await prisma.wallet.upsert({
    where: { userId: process.env.ADMIN_USER_ID! },
    create: {
      userId: process.env.ADMIN_USER_ID!,
      balance: amount,
    },
    update: {
      balance: { increment: amount },
    },
  });

  await prisma.vendorBookingTransaction.create({
    data: {
      bookingId: metadata.bookingId,
      amount,
      type: VendorBookingTransactionType.APP_COMMISSION,
      status: "COMPLETED",
      senderId: metadata.senderId,
      receiverId: process.env.ADMIN_USER_ID!,
      description,
      metadata,
    },
  });

  return appWallet;
}

// Get vendor fare estimate
export const getVendorFareEstimate = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    serviceType,
    vendorPrice,
    tripType,
  } = req.body;

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    if (vehicleType.startsWith("tempo_") && tripType !== "ROUND_TRIP") {
      return res.status(400).json({
        error: "Tempo vehicles are only available for round trips",
      });
    }

    const baseFare = calculateAppBasePrice(
      distance,
      vehicleType,
      serviceType,
      tripType
    );

    // Calculate commissions and payouts
    const appCommissionFromBase = Math.round(baseFare * 0.12); // 12% commission
    const vendorCommission = vendorPrice - baseFare;
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = baseFare - appCommissionFromBase;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

    res.json({
      estimate: {
        distance,
        duration,
        appBasePrice: baseFare,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        breakdown: {
          appCommissionFromBase,
          appCommissionFromVendor,
          driverCommission: appCommissionFromBase,
        },
        tripDetails: {
          type: tripType || "ONE_WAY",
          isTempoVehicle: vehicleType.startsWith("tempo_"),
        },
      },
    });
  } catch (error) {
    console.error("Error calculating fare estimate:", error);
    res.status(500).json({ error: "Failed to calculate fare estimate" });
  }
};

// Create vendor booking
export const createVendorBooking = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "VENDOR") {
    return res.status(403).json({ error: "Unauthorized. Vendor access only." });
  }

  const {
    pickupLocation,
    dropLocation,
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    vehicleCategory,
    serviceType,
    vendorPrice, // This is the total booking amount (e.g., Rs 5000)
    tripType,
    startDate,
    endDate,
    pickupTime,
    notes,
  } = req.body;

  try {
    // Get distance and duration
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLat, lng: pickupLng },
      { lat: dropLat, lng: dropLng }
    );

    // Calculate app base price (our rate, e.g., Rs 3000)
    const appBasePrice = calculateAppBasePrice(
      distance,
      vehicleCategory,
      serviceType,
      tripType
    );

    // Calculate commissions
    const vendorCommission = vendorPrice - appBasePrice;

    const appCommission = Math.round(appBasePrice * 0.12);

    const totalCommission = vendorCommission + appCommission;

    const driverPayout = vendorPrice - totalCommission;

    const booking = await prisma.vendorBooking.create({
      data: {
        vendor: {
          connect: { id: req.user.userId },
        },
        serviceType,
        tripType,
        pickupLocation,
        dropLocation,
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
        vehicleCategory,
        distance,
        duration,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        pickupTime,
        totalDays: Math.ceil(
          (new Date(endDate).getTime() - new Date(startDate).getTime()) /
            (1000 * 60 * 60 * 24)
        ),
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission,
        driverPayout,
        vendorPayout: vendorCommission, // Vendor gets their full commission
        status: "PENDING",
        notes,
      },
    });

    res.json({
      booking,
      breakdown: {
        totalAmount: vendorPrice,
        appBasePrice,
        vendorCommission,
        appCommission,
        totalCommission,
        driverPayout,
        vendorPayout: vendorCommission,
      },
    });
  } catch (error) {
    console.error("Error creating vendor booking:", error);
    res.status(500).json({ error: "Failed to create booking" });
  }
};

// Create driver commission payment order
export const createDriverCommissionPayment = async (
  req: Request,
  res: Response
) => {
  const { bookingId } = req.params;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.vendorBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Driver pays both vendor commission and app commission
    const totalCommissionAmount =
      booking.vendorCommission + booking.appCommission;

    const shortBookingId = bookingId.slice(-8);
    const receiptId = `comm_${shortBookingId}`;

    // Add await here
    const order = await razorpay.orders.create({
      amount: Math.round(totalCommissionAmount * 100), // Convert to paise
      currency: "INR",
      receipt: receiptId,
      notes: {
        bookingId,
        type: "driver_commission",
        amount: totalCommissionAmount,
        breakdown: {
          vendorCommission: booking.vendorCommission,
          appCommission: booking.appCommission,
        },
      },
    });

    res.json({ order });
  } catch (error) {
    console.error("Error creating payment order:", error);
    res.status(500).json({ error: "Failed to create payment order" });
  }
};
// Update verify payment to handle commission
export const verifyDriverCommissionPayment = async (
  req: Request,
  res: Response
) => {
  const { bookingId } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    // Verify payment signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const updatedBooking = await prisma.$transaction(async (prisma) => {
      const booking = await prisma.vendorBooking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) {
        throw new Error("Booking not found");
      }

      // Add vendor commission to vendor's wallet
      await prisma.wallet.upsert({
        where: { userId: booking.vendorId },
        create: {
          userId: booking.vendorId,
          balance: booking.vendorCommission,
        },
        update: {
          balance: { increment: booking.vendorCommission },
        },
      });

      // Add app commission to app wallet
      await createAppWalletTransaction(
        booking.appCommission,
        "App commission from driver",
        {
          bookingId,
          senderId: req.user!.userId,
          type: "APP_COMMISSION",
          razorpayPaymentId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id,
        }
      );

      // Record vendor commission transaction
      await prisma.vendorBookingTransaction.create({
        data: {
          bookingId,
          amount: booking.vendorCommission,
          type: VendorBookingTransactionType.VENDOR_PAYOUT,
          status: TransactionStatus.COMPLETED,
          senderId: req.user!.userId,
          receiverId: booking.vendorId,
          description: "Vendor commission from driver",
        },
      });

      // Update booking status
      return prisma.vendorBooking.update({
        where: { id: bookingId },
        data: {
          status: "DRIVER_ACCEPTED",
          driverId: req.user!.userId,
          driverAcceptedAt: new Date(),
          driverCommissionPaid: true,
        },
      });
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
};

// Update cancel booking endpoint
export const cancelVendorBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { reason } = req.body;

  if (!req.user?.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const booking = await prisma.vendorBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Check if user is authorized to cancel (either vendor or assigned driver)
    if (
      booking.vendorId !== req.user.userId &&
      booking.driverId !== req.user.userId
    ) {
      return res
        .status(403)
        .json({ error: "Not authorized to cancel this booking" });
    }

    // Check if booking can be cancelled
    if (booking.status === "COMPLETED" || booking.status === "CANCELLED") {
      return res.status(400).json({ error: "Booking cannot be cancelled" });
    }

    // If driver has paid commission, initiate refund process
    if (booking.driverCommissionPaid) {
      await prisma.$transaction(async (prisma) => {
        // Refund app commission to driver's wallet
        await prisma.wallet.upsert({
          where: { userId: booking.driverId! },
          create: {
            userId: booking.driverId!,
            balance: booking.appCommission,
          },
          update: {
            balance: { increment: booking.appCommission },
          },
        });

        // Deduct from app wallet
        await prisma.wallet.update({
          where: { userId: process.env.ADMIN_USER_ID! },
          data: {
            balance: { decrement: booking.appCommission },
          },
        });

        // Add refund transaction record
        await prisma.vendorBookingTransaction.create({
          data: {
            bookingId,
            amount: booking.appCommission,
            type: VendorBookingTransactionType.DRIVER_PAYOUT,
            status: TransactionStatus.COMPLETED,
            senderId: process.env.ADMIN_USER_ID!,
            receiverId: booking.driverId!,
            description: "Commission refund for cancelled booking",
          },
        });

        // Update booking status
        await prisma.vendorBooking.update({
          where: { id: bookingId },
          data: {
            status: "CANCELLED",
            cancelledBy: CancelledBy.USER || CancelledBy.DRIVER,
            cancelReason: reason || "No reason provided",
            cancelledAt: new Date(),
          },
        });
      });
    } else {
      // If no commission paid, simply cancel the booking
      await prisma.vendorBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelledBy: CancelledBy.USER || CancelledBy.DRIVER,
          cancelReason: reason,
          cancelledAt: new Date(),
        },
      });
    }

    res.json({ success: true, message: "Booking cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
};

// Start ride
export const startVendorRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.vendorBooking.update({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
      },
      data: {
        status: "STARTED",
        rideStartedAt: new Date(),
      },
    });

    res.json({ booking });
  } catch (error) {
    console.error("Error starting ride:", error);
    res.status(500).json({ error: "Failed to start ride" });
  }
};

// Complete ride
export const completeVendorRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const result = await prisma.$transaction(async (prisma) => {
      const booking = await prisma.vendorBooking.findUnique({
        where: {
          id: bookingId,
          driverId: req.user!.userId,
          status: VendorBookingStatus.STARTED,
        },
      });

      if (!booking) {
        throw new Error("Booking not found or invalid status");
      }

      // Driver receives their payout amount (total amount minus commissions)
      await prisma.wallet.upsert({
        where: { userId: req.user!.userId },
        create: {
          userId: req.user!.userId,
          balance: booking.driverPayout,
        },
        update: {
          balance: { increment: booking.driverPayout },
        },
      });

      // Record driver payout transaction
      await prisma.vendorBookingTransaction.create({
        data: {
          bookingId,
          amount: booking.driverPayout,
          type: VendorBookingTransactionType.DRIVER_PAYOUT,
          status: TransactionStatus.COMPLETED,
          senderId: booking.vendorId,
          receiverId: req.user!.userId,
          description: "Driver payout for completed ride",
        },
      });

      // Update booking status
      const updatedBooking = await prisma.vendorBooking.update({
        where: { id: bookingId },
        data: {
          status: VendorBookingStatus.COMPLETED,
          rideEndedAt: new Date(),
        },
      });

      return {
        booking: updatedBooking,
        payoutDetails: {
          totalAmount: booking.vendorPrice,
          driverPayout: booking.driverPayout,
          commissionBreakdown: {
            vendorCommission: booking.vendorCommission,
            appCommission: booking.appCommission,
            totalCommission: booking.vendorCommission + booking.appCommission,
          },
        },
      };
    });

    res.json({
      success: true,
      message: "Ride completed and payment processed successfully",
      ...result,
    });
  } catch (error) {
    console.error("Error completing ride:", error);
    res.status(500).json({ error: "Failed to complete ride" });
  }
};

// Get vendor bookings
export const getVendorBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  const { status, page = 1, limit = 10 } = req.query;

  try {
    //For drivers, first get their vehicle category
    let driverVehicleCategory;
    if (req.user.userType === "DRIVER") {
      const driverDetails = await prisma.driverDetails.findUnique({
        where: { userId: req.user.userId },
        select: { vehicleCategory: true },
      });
      driverVehicleCategory = driverDetails?.vehicleCategory;
    }

    const where = {
      ...(req.user.userType === "VENDOR"
        ? {
            vendorId: req.user.userId,
          }
        : req.user.userType === "DRIVER"
          ? {
              // For drivers: show only pending bookings if no status specified
              // AND match their vehicle category
              ...(status
                ? {
                    status: status as VendorBookingStatus,
                    driverId: req.user.userId,
                  }
                : {
                    status: VendorBookingStatus.PENDING,
                    vehicleCategory: driverVehicleCategory, // Only show bookings matching driver's vehicle
                  }),
            }
          : {}),
    };

    const bookings = await prisma.vendorBooking.findMany({
      where,
      include: {
        vendor: {
          select: {
            name: true,
            phone: true,
          },
        },
        driver: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });

    const total = await prisma.vendorBooking.count({ where });

    res.json({
      bookings,
      pagination: {
        total,
        pages: Math.ceil(total / Number(limit)),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
};

// Get vendor booking details
export const getVendorBookingDetails = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.vendorBooking.findFirst({
      where: {
        id: bookingId,
      },
      include: {
        vendor: {
          select: {
            name: true,
            phone: true,
          },
        },
        driver: {
          select: {
            name: true,
            phone: true,
          },
        },
        transactions: true,
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ booking });
  } catch (error) {
    console.error("Error fetching booking details:", error);
    res.status(500).json({ error: "Failed to fetch booking details" });
  }
};

// Get vendor wallet
export const getVendorWallet = async (req: Request, res: Response) => {
  if (!req.user?.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user.userId },
      include: {
        user: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
    });

    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    const recentTransactions = await prisma.vendorBookingTransaction.findMany({
      where: {
        OR: [{ senderId: req.user.userId }, { receiverId: req.user.userId }],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        booking: {
          select: {
            pickupLocation: true,
            dropLocation: true,
            serviceType: true,
          },
        },
      },
    });

    res.json({
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency,
        user: wallet.user,
      },
      recentTransactions,
    });
  } catch (error) {
    console.error("Error fetching wallet details:", error);
    res.status(500).json({ error: "Failed to fetch wallet details" });
  }
};

// Get vendor transactions
export const getVendorTransactions = async (req: Request, res: Response) => {
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  const { page = 1, limit = 10 } = req.query;

  try {
    const transactions = await prisma.vendorBookingTransaction.findMany({
      where: {
        OR: [{ senderId: req.user.userId }, { receiverId: req.user.userId }],
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });

    const total = await prisma.vendorBookingTransaction.count({
      where: {
        OR: [{ senderId: req.user.userId }, { receiverId: req.user.userId }],
      },
    });

    res.json({
      transactions,
      pagination: {
        total,
        pages: Math.ceil(total / Number(limit)),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
};

// Get vendor earnings
export const getVendorEarnings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "VENDOR") {
    return res.status(403).json({ error: "Unauthorized. Vendor access only." });
  }

  const { startDate, endDate } = req.query;

  try {
    const where = {
      vendorId: req.user.userId,
      status: VendorBookingStatus.COMPLETED,
      ...(startDate && endDate
        ? {
            createdAt: {
              gte: new Date(startDate as string),
              lte: new Date(endDate as string),
            },
          }
        : {}),
    };

    const bookings = await prisma.vendorBooking.findMany({
      where,
      select: {
        id: true,
        vendorPrice: true,
        vendorPayout: true,
        appCommission: true,
        createdAt: true,
      },
    });

    const totalEarnings = bookings.reduce(
      (sum, booking) => sum + booking.vendorPayout,
      0
    );

    res.json({
      earnings: {
        total: totalEarnings,
        bookings,
        count: bookings.length,
      },
    });
  } catch (error) {
    console.error("Error fetching earnings:", error);
    res.status(500).json({ error: "Failed to fetch earnings" });
  }
};

// Helper function to calculate base price
function calculateAppBasePrice(
  distance: number,
  vehicleType: string,
  serviceType: LongDistanceServiceType,
  tripType: string
): number {
  const rates = VENDOR_RATES[serviceType];
  if (!rates || !rates[vehicleType]) {
    throw new Error(
      `Invalid vehicle type or service type: ${vehicleType}, ${serviceType}`
    );
  }

  let baseFare = 0;
  const rate = rates[vehicleType];

  switch (serviceType) {
    case "OUTSTATION":
      if (vehicleType.startsWith("tempo_")) {
        baseFare = rate.fixed;
        if (distance > 250) {
          baseFare += (distance - 250) * rate.extra;
        }
      } else {
        const ratePerKm = distance <= 150 ? rate.short : rate.base;
        baseFare = distance * ratePerKm;
        if (tripType === "ROUND_TRIP") {
          baseFare *= 2;
        }
      }
      break;

    case "HILL_STATION":
      if (vehicleType.startsWith("tempo_")) {
        baseFare = rate.fixed;
        if (distance > 250) {
          baseFare += (distance - 250) * rate.extra;
        }
      } else {
        baseFare = distance * rate.base;
      }
      break;

    case "ALL_INDIA_TOUR":
      const numberOfDays = Math.ceil(distance / 250);
      baseFare = rate.perDay * numberOfDays;
      const allowedDistance = 250 * numberOfDays;
      if (distance > allowedDistance) {
        baseFare += (distance - allowedDistance) * rate.extraKm;
      }
      break;

    case "CHARDHAM_YATRA":
      if (vehicleType.startsWith("tempo_")) {
        baseFare = rate.fixed;
        if (distance > 250) {
          baseFare += (distance - 250) * rate.extra;
        }
      } else {
        baseFare = distance * rate.base;
      }
      break;
  }

  return Math.round(baseFare);
}
