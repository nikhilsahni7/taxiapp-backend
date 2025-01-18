import type { Request, Response } from "express";
import {
  PrismaClient,
  VendorBookingStatus,
  VendorBookingTransactionType,
  LongDistanceServiceType,
  TransactionStatus,
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
    mini: { base: 14, short: 17 }, // Increased by 3
    sedan: { base: 17, short: 22 }, // Increased by 3
    ertiga: { base: 21, short: 27 }, // Increased by 3
    innova: { base: 27, short: 30 }, // Increased by 3
    tempo_12: { fixed: 14000, extra: 26 }, // Increased by 3
    tempo_16: { fixed: 16000, extra: 29 }, // Increased by 3
    tempo_20: { fixed: 18000, extra: 33 }, // Increased by 3
    tempo_26: { fixed: 20000, extra: 38 }, // Increased by 3
  },
  HILL_STATION: {
    mini: { base: 23 }, // Increased by 3
    sedan: { base: 30 }, // Increased by 3
    ertiga: { base: 33 }, // Increased by 3
    innova: { base: 38 }, // Increased by 3
    tempo_12: { fixed: 14000, extra: 26 }, // Increased by 3
    tempo_16: { fixed: 16000, extra: 29 }, // Increased by 3
    tempo_20: { fixed: 18000, extra: 33 }, // Increased by 3
    tempo_26: { fixed: 20000, extra: 38 }, // Increased by 3
  },
  ALL_INDIA_TOUR: {
    mini: { perDay: 3700, extraKm: 14 }, // Increased by 700 and 3
    sedan: { perDay: 4200, extraKm: 17 }, // Increased by 700 and 3
    ertiga: { perDay: 5500, extraKm: 21 }, // Increased by 700 and 3
    innova: { perDay: 6300, extraKm: 27 }, // Increased by 700 and 3
    tempo_12: { perDay: 14700, extraKm: 26 }, // Increased by 700 and 3
    tempo_16: { perDay: 16700, extraKm: 29 }, // Increased by 700 and 3
    tempo_20: { perDay: 18700, extraKm: 33 }, // Increased by 700 and 3
    tempo_26: { perDay: 20700, extraKm: 38 }, // Increased by 700 and 3
  },
  CHARDHAM_YATRA: {
    mini: { base: 28 }, // Increased by 3
    sedan: { base: 33 }, // Increased by 3
    ertiga: { base: 38 }, // Increased by 3
    innova: { base: 43 }, // Increased by 3
    tempo_12: { fixed: 8000, extra: 28 }, // Increased by 3
    tempo_16: { fixed: 9000, extra: 31 }, // Increased by 3
    tempo_20: { fixed: 10000, extra: 35 }, // Increased by 3
    tempo_26: { fixed: 11000, extra: 40 }, // Increased by 3
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
    vendorPrice,
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

    // Calculate app base price
    const appBasePrice = calculateAppBasePrice(
      distance,
      vehicleCategory,
      serviceType,
      tripType
    );

    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromBase = appBasePrice * 0.12;
    const appCommissionFromVendor = vendorCommission * 0.1;
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = appBasePrice - appCommissionFromBase;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

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
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        status: "PENDING",
        notes,
      },
    });

    res.json({ booking });
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

    // Calculate driver commission as appBasePrice - driverPayout
    const driverCommissionAmount = booking.appBasePrice - booking.driverPayout;

    // Create a shorter receipt ID using last 8 characters of bookingId
    const shortBookingId = bookingId.slice(-8);
    const receiptId = `comm_${shortBookingId}`;

    const order = await razorpay.orders.create({
      amount: Math.round(driverCommissionAmount * 100),
      currency: "INR",
      receipt: receiptId, // Shortened receipt ID
      notes: {
        bookingId,
        type: "driver_commission",
      },
    });

    res.json({ order });
  } catch (error) {
    console.error("Error creating payment order:", error);
    res.status(500).json({
      error: "Failed to create payment order",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Verify driver commission payment and accept booking
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
      const booking = await prisma.vendorBooking.update({
        where: { id: bookingId },
        data: {
          status: "DRIVER_ACCEPTED",
          driverId: req.user!.userId,
          driverAcceptedAt: new Date(),
          driverCommissionPaid: true,
        },
      });

      // Add driver's commission to app wallet
      const driverCommission = booking.appBasePrice * 0.12;
      await createAppWalletTransaction(
        driverCommission,
        "Driver commission (12% of base price)",
        {
          bookingId,
          senderId: req.user!.userId,
          type: "DRIVER_COMMISSION",
          razorpayPaymentId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id,
        }
      );

      return booking;
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
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
        include: {
          vendor: {
            select: {
              wallet: true,
            },
          },
        },
      });

      if (!booking) {
        throw new Error("Booking not found or invalid status");
      }

      // Calculate all amounts
      const driverCommission = booking.appBasePrice * 0.12; // Already paid by driver
      const driverPayout = booking.appBasePrice - driverCommission; // Amount driver should receive
      const vendorMarkup = booking.vendorPrice - booking.appBasePrice; // Vendor's markup
      const vendorCommissionToApp = vendorMarkup * 0.1; // 10% of vendor markup
      const vendorFinalPayout = vendorMarkup * 0.9; // 90% of vendor markup

      // 1. Deduct total amount from vendor's wallet
      const totalDeduction = driverPayout + vendorCommissionToApp;
      await prisma.wallet.update({
        where: { userId: booking.vendorId },
        data: {
          balance: {
            decrement: totalDeduction,
          },
        },
      });

      // 2. Pay driver their share
      await prisma.wallet.upsert({
        where: { userId: req.user!.userId },
        create: {
          userId: req.user!.userId,
          balance: driverPayout,
        },
        update: {
          balance: {
            increment: driverPayout,
          },
        },
      });

      // 3. Record driver payout transaction
      await prisma.vendorBookingTransaction.create({
        data: {
          bookingId,
          amount: driverPayout,
          type: VendorBookingTransactionType.DRIVER_PAYOUT,
          status: TransactionStatus.COMPLETED,
          senderId: booking.vendorId,
          receiverId: req.user!.userId,
          description: "Driver payout from vendor",
        },
      });

      // 4. Add vendor's commission to app wallet
      await createAppWalletTransaction(
        vendorCommissionToApp,
        "Vendor commission (10% of markup)",
        {
          bookingId,
          senderId: booking.vendorId,
          type: "VENDOR_COMMISSION",
        }
      );

      // 5. Update booking status
      const updatedBooking = await prisma.vendorBooking.update({
        where: { id: bookingId },
        data: {
          status: VendorBookingStatus.COMPLETED,
          rideEndedAt: new Date(),
          vendorPaidAt: new Date(),
        },
      });

      return {
        booking: updatedBooking,
        payoutDetails: {
          totalPrice: booking.vendorPrice,
          appBasePrice: booking.appBasePrice,
          breakdown: {
            driverCommission, // Paid by driver initially
            driverPayout, // Paid from vendor's wallet
            vendorMarkup,
            vendorCommissionToApp,
            vendorFinalPayout,
            totalDeductionFromVendor: totalDeduction,
          },
        },
      };
    });

    res.json({
      success: true,
      message: "Ride completed and all payouts processed successfully",
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

function calculateAppBasePrice(
  distance: number,
  vehicleType: string,
  serviceType: LongDistanceServiceType,
  tripType: string
): number {
  const rates = VENDOR_RATES[serviceType]?.[vehicleType.toLowerCase()];
  if (!rates) {
    throw new Error(`Invalid vehicle type or service type`);
  }

  let baseFare = 0;
  const normalizedVehicleType = vehicleType.toLowerCase();

  if (serviceType === "ALL_INDIA_TOUR") {
    baseFare = rates.perDay;
    if (distance > 250) {
      const extraKm = distance - 250;
      baseFare += extraKm * rates.extraKm;
    }
    // Ensure round trip logic is applied
    if (tripType === "ROUND_TRIP") {
      baseFare *= 2;
    }
  } else if (normalizedVehicleType.startsWith("tempo_")) {
    baseFare = rates.fixed;
    if (distance > 250) {
      const extraKm = distance - 250;
      baseFare += extraKm * rates.extra;
    }
    if (tripType === "ROUND_TRIP") {
      baseFare *= 2;
    }
  } else {
    // For cars
    const ratePerKm =
      serviceType === "OUTSTATION" && distance <= 150
        ? rates.short
        : rates.base;
    baseFare = distance * ratePerKm;

    if (tripType === "ROUND_TRIP") {
      baseFare *= 2;
    }
  }

  return Math.round(baseFare);
}
