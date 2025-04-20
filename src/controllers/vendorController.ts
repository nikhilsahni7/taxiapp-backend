import {
  CancelledBy,
  LongDistanceServiceType,
  PrismaClient,
  TransactionStatus,
  VendorBookingStatus,
  VendorBookingTransactionType,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";
const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

// Define the rates with proper type
const VENDOR_RATES: Record<LongDistanceServiceType, Record<string, any>> = {
  OUTSTATION: {
    mini: { base: 13, short: 17 },
    sedan: { base: 15, short: 20 },
    ertiga: { base: 18, short: 23 },
    innova: { base: 21, short: 27 },
    tempo_12: { fixed: 8500, extra: 26 },
    tempo_16: { fixed: 9500, extra: 29 },
    tempo_20: { fixed: 10500, extra: 33 },
    tempo_26: { fixed: 11500, extra: 38 },
  },
  HILL_STATION: {
    mini: { base: 18 },
    sedan: { base: 23 },
    ertiga: { base: 27 },
    innova: { base: 30 },
    tempo_12: { fixed: 8500, extra: 26 },
    tempo_16: { fixed: 9500, extra: 29 },
    tempo_20: { fixed: 10500, extra: 33 },
    tempo_26: { fixed: 11500, extra: 38 },
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
};

// Chardham Yatra rates based on vehicle type
const CHARDHAM_RATES = {
  mini: { perDayRate: 3400, perKmRate: 11 },
  sedan: { perDayRate: 4000, perKmRate: 14 },
  ertiga: { perDayRate: 5500, perKmRate: 18 },
  innova: { perDayRate: 6500, perKmRate: 24 },
  tempo_12: { perDayRate: 8500, perKmRate: 23 },
  tempo_16: { perDayRate: 9500, perKmRate: 26 },
  tempo_20: { perDayRate: 10500, perKmRate: 30 },
  tempo_26: { perDayRate: 11500, perKmRate: 35 },
};

// Days required based on number of dhams and starting point
const CHARDHAM_DAYS = {
  haridwar_rishikesh: {
    1: 3, // 1 dham - 3 days
    2: 5, // 2 dhams - 5 days
    3: 7, // 3 dhams - 7 days
    4: 10, // 4 dhams - 10 days
  },
  delhi: {
    1: 5, // 1 dham - 5 days
    2: 7, // 2 dhams - 7 days
    3: 9, // 3 dhams - 9 days
    4: 12, // 4 dhams - 12 days
  },
  other: {
    1: 3, // 1 dham - 3 days
    2: 5, // 2 dhams - 5 days
    3: 7, // 3 dhams - 7 days
    4: 10, //4 dhams -10 days
  },
};

interface Location {
  address: string;
  lat: number;
  lng: number;
}

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

    // Calculate app base price (our rate, e.g., Rs 3000)
    const appBasePrice = calculateAppBasePrice(
      distance,
      vehicleCategory,
      serviceType,
      tripType
    );

    // Calculate commissions
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromBase = Math.round(appBasePrice * 0.12);
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = vendorPrice - totalAppCommission;
    const vendorPayout = vendorCommission - appCommissionFromVendor; // Correct calculation matching estimate

    // Determine end date based on service type and trip type
    let calculatedEndDate;
    if (
      (serviceType === "OUTSTATION" || serviceType === "HILL_STATION") &&
      tripType === "ONE_WAY"
    ) {
      // For one-way outstation and hill station trips, end date is same as start date
      calculatedEndDate = new Date(startDate);
    } else if (endDate) {
      // Use provided end date if available
      calculatedEndDate = new Date(endDate);
    } else {
      // Default calculation (for round trips)
      calculatedEndDate = new Date(startDate);
      calculatedEndDate.setDate(calculatedEndDate.getDate() + 1); // Default to next day
    }

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
        endDate: calculatedEndDate,
        pickupTime,
        totalDays: Math.ceil(
          (calculatedEndDate.getTime() - new Date(startDate).getTime()) /
            (1000 * 60 * 60 * 24)
        ),
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout, // Now using the corrected value
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
        appCommission: totalAppCommission,
        totalCommission: vendorCommission + totalAppCommission,
        driverPayout,
        vendorPayout,
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

      // Add app commission to app wallet
      await createAppWalletTransaction(
        booking.appCommission + booking.vendorCommission, // The app collects total commission
        "Total commission from driver",
        {
          bookingId,
          senderId: req.user!.userId,
          type: "APP_COMMISSION",
          razorpayPaymentId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id,
        }
      );

      // Record commission transaction (for tracking only)
      await prisma.vendorBookingTransaction.create({
        data: {
          bookingId,
          amount: booking.vendorCommission + booking.appCommission,
          type: VendorBookingTransactionType.APP_COMMISSION,
          status: TransactionStatus.COMPLETED,
          senderId: req.user!.userId,
          receiverId: process.env.ADMIN_USER_ID!,
          description: "Total commission from driver",
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

    // Simply update the booking status - no wallet operations
    await prisma.vendorBooking.update({
      where: { id: bookingId },
      data: {
        status: "CANCELLED",
        cancelledBy: CancelledBy.USER || CancelledBy.DRIVER,
        cancelReason: reason || "No reason provided",
        cancelledAt: new Date(),
      },
    });

    res.json({ success: true, message: "Booking cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
};

// Driver starts journey to pickup location
export const startDriverPickup = async (req: Request, res: Response) => {
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
        status: VendorBookingStatus.DRIVER_PICKUP_STARTED,
      },
    });

    res.json({ booking });
  } catch (error) {
    console.error("Error starting pickup:", error);
    res.status(500).json({ error: "Failed to start pickup" });
  }
};

// Driver arrived at pickup location
export const driverArrived = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.vendorBooking.update({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: VendorBookingStatus.DRIVER_PICKUP_STARTED,
      },
      data: {
        status: VendorBookingStatus.DRIVER_ARRIVED,
        driverArrivedAt: new Date(),
        otp: Math.floor(1000 + Math.random() * 9000).toString(), // 4-digit OTP
      },
    });

    res.json({ booking });
  } catch (error) {
    console.error("Error updating driver arrival:", error);
    res.status(500).json({ error: "Failed to update driver arrival" });
  }
};

// Start ride with OTP verification
export const startVendorRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { otp } = req.body;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.vendorBooking.findFirst({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: VendorBookingStatus.DRIVER_ARRIVED,
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (booking.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const updatedBooking = await prisma.vendorBooking.update({
      where: { id: bookingId },
      data: {
        status: VendorBookingStatus.STARTED,
        rideStartedAt: new Date(),
      },
    });

    res.json({ booking: updatedBooking });
  } catch (error) {
    console.error("Error starting ride:", error);
    res.status(500).json({ error: "Failed to start ride" });
  }
};

// Complete ride - keep only vendor wallet update
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

      // Pay vendor payout to vendor's wallet - KEEP THIS
      await prisma.wallet.upsert({
        where: { userId: booking.vendorId },
        create: {
          userId: booking.vendorId,
          balance: booking.vendorPayout,
        },
        update: {
          balance: { increment: booking.vendorPayout },
        },
      });

      // Record vendor payout transaction
      await prisma.vendorBookingTransaction.create({
        data: {
          bookingId,
          amount: booking.vendorPayout,
          type: VendorBookingTransactionType.VENDOR_PAYOUT,
          status: TransactionStatus.COMPLETED,
          senderId: process.env.ADMIN_USER_ID!,
          receiverId: booking.vendorId,
          description: "Vendor payout for completed ride",
        },
      });

      // Deduct from app wallet
      await prisma.wallet.update({
        where: { userId: process.env.ADMIN_USER_ID! },
        data: {
          balance: { decrement: booking.vendorPayout },
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
          vendorPayout: booking.vendorPayout,
        },
      };
    });

    res.json({
      success: true,
      message: "Ride completed successfully",
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

  const { status, statuses, page = 1, limit = 10, date } = req.query;

  try {
    // For drivers, first get their vehicle category
    let driverVehicleCategory;
    if (req.user.userType === "DRIVER") {
      const driverDetails = await prisma.driverDetails.findUnique({
        where: { userId: req.user.userId },
        select: { vehicleCategory: true },
      });
      driverVehicleCategory = driverDetails?.vehicleCategory;
    }

    // Handle the new 'statuses' parameter
    let statusFilter = {};
    if (statuses) {
      // Parse comma-separated statuses
      const statusArray = (statuses as string).split(",");
      statusFilter = {
        status: {
          in: statusArray as VendorBookingStatus[],
        },
      };
    } else if (status) {
      statusFilter = {
        status: status as VendorBookingStatus,
      };
    }

    // Add date filter if provided
    let dateFilter = {};
    if (date) {
      const targetDate = new Date(date as string);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);

      dateFilter = {
        startDate: {
          gte: targetDate,
          lt: nextDay,
        },
      };
    }

    const where = {
      ...(req.user.userType === "VENDOR"
        ? {
            vendorId: req.user.userId,
            ...statusFilter,
            ...dateFilter,
          }
        : req.user.userType === "DRIVER"
          ? {
              // For drivers: show only pending bookings if no status specified
              // AND match their vehicle category
              ...(status || statuses
                ? {
                    ...statusFilter,
                    driverId: req.user.userId,
                    ...dateFilter,
                  }
                : {
                    status: VendorBookingStatus.PENDING,
                    vehicleCategory: driverVehicleCategory, // Only show bookings matching driver's vehicle
                    ...dateFilter,
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
        if (tripType === "ROUND_TRIP") {
          baseFare *= 2;
        }
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
  }

  return Math.round(baseFare);
}

// Helper function to get vehicle capacity
const getVehicleCapacity = (vehicleType: string): string => {
  const capacities: { [key: string]: string } = {
    mini: "4 seater",
    sedan: "4 seater",
    ertiga: "6 seater",
    innova: "7 seater",
    tempo_12: "12 seater",
    tempo_16: "16 seater",
    tempo_20: "20 seater",
    tempo_26: "26 seater",
  };
  return capacities[vehicleType] || "N/A";
};

// Helper function to calculate extra days based on distance
const calculateExtraDays = (distance: number): number => {
  if (distance <= 0) return 0;

  // Add 2 days for every complete 250km
  const completeChunks = Math.floor(distance / 250);
  let extraDays = completeChunks * 2;

  // Get remaining kilometers after complete chunks
  const remainingKm = distance % 250;

  // If remaining km is 200 or more, add 2 more days instead of per-km charge
  if (remainingKm >= 200) {
    extraDays += 2;
  }

  return extraDays;
};

// Helper function to calculate extra km charges
const calculateExtraKmCharges = (
  distance: number,
  vehicleType: string
): number => {
  if (distance <= 0) return 0;

  // Get per km rate for vehicle type
  //@ts-ignore
  const { perKmRate } = CHARDHAM_RATES[vehicleType];

  // Calculate the remaining km after last complete 250km chunk
  const remainingKm = Math.floor(distance % 250); // Floor to ensure exact calculation

  // Only charge per km if remaining distance is less than 200km
  // Otherwise, it will be covered by extra days
  if (remainingKm < 200) {
    // For all remaining km, double the actual distance and then apply per km rate
    const doubledDistance = remainingKm * 2;
    const charge = doubledDistance * perKmRate;

    // Return rounded value to avoid floating point issues
    return Math.round(charge);
  }

  return 0; // If remainingKm >= 200, we add extra days instead of charging per km
};

// Helper function to check if location is in Haridwar/Rishikesh area
const isHaridwarRishikeshArea = async (
  location: Location
): Promise<boolean> => {
  // Center of Haridwar area
  const haridwarLat = 29.9457;
  const haridwarLng = 78.1642;

  // Center of Rishikesh area
  const rishikeshLat = 30.0869;
  const rishikeshLng = 78.2676;

  // Calculate distance from Haridwar center (approximate)
  const haridwarDistance =
    Math.sqrt(
      Math.pow(location.lat - haridwarLat, 2) +
        Math.pow(location.lng - haridwarLng, 2)
    ) * 111; // 1 degree is approximately 111 km

  // Calculate distance from Rishikesh center (approximate)
  const rishikeshDistance =
    Math.sqrt(
      Math.pow(location.lat - rishikeshLat, 2) +
        Math.pow(location.lng - rishikeshLng, 2)
    ) * 111;

  // If within 25km of either city
  return haridwarDistance <= 25 || rishikeshDistance <= 25;
};

// Helper function to check if location is in Delhi area
const isDelhiArea = async (location: Location): Promise<boolean> => {
  // Center of Delhi area
  const delhiLat = 28.7041;
  const delhiLng = 77.1025;

  // Calculate distance from Delhi center (approximate)
  const delhiDistance =
    Math.sqrt(
      Math.pow(location.lat - delhiLat, 2) +
        Math.pow(location.lng - delhiLng, 2)
    ) * 111; // 1 degree is approximately 111 km

  // If within 50km of Delhi
  return delhiDistance <= 50;
};

// Get vendor Chardham fare estimate
export const getVendorChardhamFareEstimate = async (
  req: Request,
  res: Response
) => {
  const {
    pickupLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
    numberOfDhams,
    selectedDhams,
    extraDays = 0,
    vendorPrice,
  } = req.body;

  try {
    // Validate input
    if (
      !pickupLocation ||
      !vehicleType ||
      !pickupTime ||
      !numberOfDhams ||
      !vendorPrice ||
      !selectedDhams ||
      selectedDhams.length === 0 ||
      selectedDhams.length !== numberOfDhams
    ) {
      return res
        .status(400)
        .json({ error: "Missing required fields or invalid selectedDhams" });
    }

    if (numberOfDhams < 1 || numberOfDhams > 4) {
      return res
        .status(400)
        .json({ error: "Number of dhams must be between 1 and 4" });
    }

    // Validate selected dhams
    const validDhams = ["YAMUNOTRI", "GANGOTRI", "KEDARNATH", "BADRINATH"];
    if (!selectedDhams.every((dham) => validDhams.includes(dham))) {
      return res.status(400).json({ error: "Invalid dham selection" });
    }

    // Get rates for vehicle type
    //@ts-ignore
    const rates = CHARDHAM_RATES[vehicleType];
    if (!rates) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    // Determine starting point type (Haridwar/Rishikesh or Delhi or Other)
    let startingPointType: "haridwar_rishikesh" | "delhi" | "other" = "other";

    if (await isHaridwarRishikeshArea(pickupLocation)) {
      startingPointType = "haridwar_rishikesh";
    } else if (await isDelhiArea(pickupLocation)) {
      startingPointType = "delhi";
    }

    // Calculate base number of days based on starting point and number of dhams
    let numberOfDays =
      CHARDHAM_DAYS[startingPointType][numberOfDhams as 1 | 2 | 3 | 4];

    // Add extra days based on distance if location is "other" (not Haridwar/Rishikesh or Delhi)
    let extraKmCharges = 0;
    let distanceToHaridwar = 0;

    if (startingPointType === "other") {
      // Calculate distance to Haridwar for extra days and charges
      const distanceResult = await getCachedDistanceAndDuration(
        { lat: pickupLocation.lat, lng: pickupLocation.lng },
        { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
      );

      distanceToHaridwar = distanceResult.distance;

      // Add extra days based on distance
      numberOfDays += calculateExtraDays(distanceToHaridwar);

      // Calculate extra km charges
      extraKmCharges = calculateExtraKmCharges(distanceToHaridwar, vehicleType);
    }

    // Add any user-requested extra days
    numberOfDays += extraDays;

    // Calculate base fare
    const baseFare = rates.perDayRate * numberOfDays;

    // Calculate total fare
    const totalFare = baseFare + extraKmCharges;

    // This is the app's base price
    const appBasePrice = totalFare;

    // Calculate vendor commissions and payouts similar to existing functions
    const appCommissionFromBase = Math.round(appBasePrice * 0.12); // 12% commission
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = appBasePrice - appCommissionFromBase;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

    // Parse dates for display
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = startDate ? new Date(startDate) : new Date();
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    let endDateTime;
    if (endDate) {
      endDateTime = new Date(endDate);
      endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    } else {
      endDateTime = new Date(startDateTime);
      endDateTime.setDate(endDateTime.getDate() + numberOfDays - 1);
    }

    // Additional information for response
    if (startingPointType === "other") {
      const result = await getCachedDistanceAndDuration(
        { lat: pickupLocation.lat, lng: pickupLocation.lng },
        { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
      );
      distanceToHaridwar = result.distance;
    }

    res.json({
      estimate: {
        baseFare,
        extraKmCharges,
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        breakdown: {
          appCommissionFromBase,
          appCommissionFromVendor,
        },
        numberOfDays,
        selectedDhams,
        perDayRate: rates.perDayRate,
        perKmRate: rates.perKmRate,
        currency: "INR",
        vehicleType,
        vehicleCapacity: getVehicleCapacity(vehicleType),
        numberOfDhams,
        startingPointType,
        distanceToHaridwar:
          startingPointType === "other" ? distanceToHaridwar : 0,
        tripDetails: {
          startDateTime: startDateTime.toISOString(),
          endDateTime: endDateTime.toISOString(),
          pickupTime,
          totalDays: numberOfDays,
        },
        details: {
          includedInFare: [
            "Driver charges",
            "Fuel charges",
            "Vehicle rental",
            `${numberOfDhams} Dham Yatra for ${numberOfDays} days`,
            vehicleType.includes("tempo")
              ? "Tempo Traveller with Push Back Seats"
              : "Car with AC",
          ],
          excludedFromFare: [
            "State tax",
            "Toll tax",
            "Parking charges",
            "Driver allowance",
            "Night charges",
            startingPointType === "other"
              ? `Extra km charges (₹${rates.perKmRate}/km up to 200km)`
              : null,
            vehicleType.includes("tempo")
              ? "Driver's food and accommodation"
              : null,
          ].filter(Boolean),
          vehicleFeatures: vehicleType.includes("tempo")
            ? [
                "Push Back Seats",
                "AC",
                "Music System",
                "LCD/LED Screen",
                "Sufficient Luggage Space",
                "First Aid Kit",
                "Reading Lights",
              ]
            : undefined,
        },
      },
    });
  } catch (error) {
    console.error("Error in Vendor Chardham fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

// Create vendor Chardham booking
export const createVendorChardhamBooking = async (
  req: Request,
  res: Response
) => {
  if (!req.user?.userId || req.user.userType !== "VENDOR") {
    return res.status(403).json({ error: "Unauthorized. Vendor access only." });
  }

  const {
    pickupLocation,
    pickupLat,
    pickupLng,
    vehicleCategory,
    startDate,
    endDate,
    pickupTime,
    numberOfDhams,
    dhamsToVisit,
    selectedDhams,
    extraDays = 0,
    vendorPrice,
    notes,
  } = req.body;

  try {
    // Validate input
    if (
      !pickupLocation ||
      !vehicleCategory ||
      !pickupTime ||
      !numberOfDhams ||
      !vendorPrice ||
      !selectedDhams ||
      selectedDhams.length === 0 ||
      selectedDhams.length !== numberOfDhams
    ) {
      return res
        .status(400)
        .json({ error: "Missing required fields or invalid selectedDhams" });
    }

    if (numberOfDhams < 1 || numberOfDhams > 4) {
      return res
        .status(400)
        .json({ error: "Number of dhams must be between 1 and 4" });
    }

    // Validate selected dhams
    const validDhams = ["YAMUNOTRI", "GANGOTRI", "KEDARNATH", "BADRINATH"];
    if (!selectedDhams.every((dham) => validDhams.includes(dham))) {
      return res.status(400).json({ error: "Invalid dham selection" });
    }

    // Get rates for vehicle type
    //@ts-ignore
    const rates = CHARDHAM_RATES[vehicleCategory];
    if (!rates) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    // Create location object for helper functions
    const location: Location = {
      address: pickupLocation,
      lat: pickupLat,
      lng: pickupLng,
    };

    // Determine starting point type (Haridwar/Rishikesh or Delhi or Other)
    let startingPointType: "haridwar_rishikesh" | "delhi" | "other" = "other";

    if (await isHaridwarRishikeshArea(location)) {
      startingPointType = "haridwar_rishikesh";
    } else if (await isDelhiArea(location)) {
      startingPointType = "delhi";
    }

    // Calculate base number of days based on starting point and number of dhams
    let numberOfDays =
      CHARDHAM_DAYS[startingPointType][numberOfDhams as 1 | 2 | 3 | 4];

    // Add extra days based on distance if location is "other" (not Haridwar/Rishikesh or Delhi)
    let extraKmCharges = 0;
    let distanceToHaridwar = 0;

    if (startingPointType === "other") {
      // Calculate distance to Haridwar for extra days and charges
      const distanceResult = await getCachedDistanceAndDuration(
        { lat: pickupLat, lng: pickupLng },
        { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
      );

      distanceToHaridwar = distanceResult.distance;

      // Add extra days based on distance
      numberOfDays += calculateExtraDays(distanceToHaridwar);

      // Calculate extra km charges
      extraKmCharges = calculateExtraKmCharges(
        distanceToHaridwar,
        vehicleCategory
      );
    }

    // Add any user-requested extra days
    numberOfDays += extraDays;

    // Calculate base fare
    const baseFare = rates.perDayRate * numberOfDays;

    // Calculate total fare - this is the app's base price
    const appBasePrice = baseFare + extraKmCharges;

    // Calculate vendor commissions and payouts
    const appCommissionFromBase = Math.round(appBasePrice * 0.12); // 12% commission
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = appBasePrice - appCommissionFromBase;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

    // Determine trip distance based on starting point
    let tripDistance = 0;
    if (startingPointType === "delhi") {
      tripDistance = 530; // Approximate distance Delhi to Chardham circuit
    } else if (startingPointType === "haridwar_rishikesh") {
      tripDistance = 350; // Approximate distance for Chardham circuit from Haridwar
    } else {
      // For other locations, add distance to Haridwar
      tripDistance = 350 + distanceToHaridwar;
    }

    // Create metadata object for booking
    const bookingMetadata = {
      numberOfDhams,
      selectedDhams,
      startingPointType,
      baseFare,
      extraKmCharges,
      distanceToHaridwar:
        startingPointType === "other" ? distanceToHaridwar : 0,
      perDayRate: rates.perDayRate,
      perKmRate: rates.perKmRate,
      vehicleCapacity: getVehicleCapacity(vehicleCategory),
      includedInFare: [
        "Driver charges",
        "Fuel charges",
        "Vehicle rental",
        `${numberOfDhams} Dham Yatra for ${numberOfDays} days`,
        vehicleCategory.includes("tempo")
          ? "Tempo Traveller with Push Back Seats"
          : "Car with AC",
      ],
    };

    // Create the booking
    const booking = await prisma.vendorBooking.create({
      data: {
        vendor: {
          connect: { id: req.user.userId },
        },
        serviceType: "CHARDHAM_YATRA",
        tripType: "ONE_WAY", // Chardham is always a circuit
        pickupLocation,
        dropLocation: "Chardham Circuit", // Fixed for Chardham
        pickupLat,
        pickupLng,
        dropLat: null, // Not applicable for Chardham
        dropLng: null, // Not applicable for Chardham
        vehicleCategory,
        distance: tripDistance,
        duration: numberOfDays * 24 * 60, // Convert days to minutes
        startDate: new Date(startDate),
        endDate: new Date(
          endDate ||
            new Date(startDate).setDate(
              new Date(startDate).getDate() + numberOfDays - 1
            )
        ),
        pickupTime,
        totalDays: numberOfDays,
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        status: "PENDING",
        notes,
        metadata: {
          ...bookingMetadata,
          selectedDhams,
        },
      },
    });

    res.json({
      booking,
      breakdown: {
        baseFare,
        extraKmCharges,
        totalAmount: vendorPrice,
        appBasePrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        numberOfDays,
        selectedDhams,
      },
    });
  } catch (error) {
    console.error("Error creating vendor Chardham booking:", error);
    res.status(500).json({ error: "Failed to create Chardham booking" });
  }
};
