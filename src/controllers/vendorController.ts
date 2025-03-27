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
    mini: { haridwar: 16500, delhi: 27000, base: 27 },
    sedan: { haridwar: 19500, delhi: 32500, base: 33 },
    ertiga: { haridwar: 22000, delhi: 37000, base: 37 },
    innova: { haridwar: 24000, delhi: 42000, base: 42 },
    tempo_12: { haridwar: 52000, delhi: 70000, extra: 26 },
    tempo_16: { haridwar: 58000, delhi: 78000, extra: 29 },
    tempo_20: { haridwar: 64000, delhi: 87000, extra: 33 },
    tempo_26: { haridwar: 70000, delhi: 95000, extra: 38 },
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
    numberOfDhams, // New field for Chardham service
  } = req.body;

  try {
    let distance = 0;
    let duration = 0;
    let baseFare = 0;

    if (serviceType === "CHARDHAM_YATRA") {
      if (!numberOfDhams) {
        return res.status(400).json({
          error: "Number of dhams is required for Chardham Yatra service",
        });
      }

      // Determine pickup area
      const pickupArea = await determinePickupArea({
        address: pickupLocation.address || pickupLocation,
        lat: pickupLocation.lat,
        lng: pickupLocation.lng,
      });

      // Set distance based on number of dhams
      switch (numberOfDhams) {
        case 1:
          distance = 550;
          break;
        case 2:
          distance = 750;
          break;
        case 3:
          distance = 950;
          break;
        case 4:
          distance = 1250;
          break;
        default:
          distance = 1250;
      }

      // Duration in minutes
      duration = numberOfDhams * 1440; // 1 day per dham

      // Calculate base fare for Chardham
      baseFare = calculateChardhamBasePrice(
        vehicleType,
        pickupArea,
        numberOfDhams
      );
    } else {
      // For other service types
      if (vehicleType.startsWith("tempo_") && tripType !== "ROUND_TRIP") {
        return res.status(400).json({
          error: "Tempo vehicles are only available for round trips",
        });
      }

      const { distance: calculatedDistance, duration: calculatedDuration } =
        await getCachedDistanceAndDuration(
          { lat: pickupLocation.lat, lng: pickupLocation.lng },
          { lat: dropLocation.lat, lng: dropLocation.lng }
        );

      distance = calculatedDistance;
      duration = calculatedDuration;

      baseFare = calculateAppBasePrice(
        distance,
        vehicleType,
        serviceType,
        tripType
      );
    }

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
          isChardham: serviceType === "CHARDHAM_YATRA",
          numberOfDhams:
            serviceType === "CHARDHAM_YATRA" ? numberOfDhams : undefined,
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
    vendorPrice, // This is the total booking amount
    tripType,
    startDate,
    endDate,
    pickupTime,
    notes,
    numberOfDhams, // New field for Chardham service
  } = req.body;

  try {
    // For Chardham service, we need special handling
    let distance = 0;
    let duration = 0;
    let appBasePrice = 0;

    if (serviceType === "CHARDHAM_YATRA") {
      // For Chardham, base price depends on pickup location and number of dhams
      const pickupArea = await determinePickupArea({
        address: pickupLocation,
        lat: pickupLat,
        lng: pickupLng,
      });

      if (!numberOfDhams) {
        return res.status(400).json({
          error: "Number of dhams is required for Chardham Yatra service",
        });
      }

      // Set distance based on number of dhams (similar to chardhamController)
      switch (numberOfDhams) {
        case 1:
          distance = 550;
          break;
        case 2:
          distance = 750;
          break;
        case 3:
          distance = 950;
          break;
        case 4:
          distance = 1250;
          break;
        default:
          distance = 1250;
      }

      // Duration in minutes (same as chardhamController)
      duration = numberOfDhams * 1440; // 1 day per dham in minutes

      // Calculate base price for Chardham
      appBasePrice = calculateChardhamBasePrice(
        vehicleCategory,
        pickupArea,
        numberOfDhams
      );
    } else {
      // For other service types, use the existing distance calculation
      const distanceDuration = await getCachedDistanceAndDuration(
        { lat: pickupLat, lng: pickupLng },
        { lat: dropLat, lng: dropLng }
      );

      distance = distanceDuration.distance;
      duration = distanceDuration.duration;

      // Calculate app base price (our rate)
      appBasePrice = calculateAppBasePrice(
        distance,
        vehicleCategory,
        serviceType,
        tripType
      );
    }

    // Calculate commissions
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromBase = Math.round(appBasePrice * 0.12);
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = vendorPrice - totalAppCommission;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

    const booking = await prisma.vendorBooking.create({
      data: {
        vendor: {
          connect: { id: req.user.userId },
        },
        serviceType,
        tripType,
        pickupLocation,
        dropLocation:
          serviceType === "CHARDHAM_YATRA" ? "Chardham Yatra" : dropLocation,
        pickupLat,
        pickupLng,
        dropLat: serviceType === "CHARDHAM_YATRA" ? null : dropLat,
        dropLng: serviceType === "CHARDHAM_YATRA" ? null : dropLng,
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
        metadata:
          serviceType === "CHARDHAM_YATRA" ? { numberOfDhams } : undefined,
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

      // Pay vendor payout from app wallet to vendor's wallet
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

      // Deduct from app wallet
      await prisma.wallet.update({
        where: { userId: process.env.ADMIN_USER_ID! },
        data: {
          balance: { decrement: booking.vendorPayout },
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

// Helper function to determine pickup area for Chardham service
async function determinePickupArea(location: {
  address: string;
  lat: number;
  lng: number;
}): Promise<string> {
  // Check if pickup location is in Haridwar/Rishikesh area
  if (await isHaridwarRishikeshArea(location)) {
    return "haridwar";
  }

  // Check if pickup location is in Delhi area
  if (await isDelhiArea(location)) {
    return "delhi";
  }

  // Default to "other" for other pickup locations
  return "other";
}

// Helper function to check if location is in Haridwar/Rishikesh area
const isHaridwarRishikeshArea = async (location: {
  address: string;
  lat: number;
  lng: number;
}): Promise<boolean> => {
  // Define the Haridwar/Rishikesh area boundaries (approximate)
  const haridwarCenter = { lat: 29.9457, lng: 78.1642 };
  const rishikeshCenter = { lat: 30.0869, lng: 78.2676 };

  // Calculate distance from both centers
  const haridwarDistance = calculateHaversineDistance(
    location.lat,
    location.lng,
    haridwarCenter.lat,
    haridwarCenter.lng
  );

  const rishikeshDistance = calculateHaversineDistance(
    location.lat,
    location.lng,
    rishikeshCenter.lat,
    rishikeshCenter.lng
  );

  // Return true if location is within 30km of either center
  return haridwarDistance <= 30 || rishikeshDistance <= 30;
};

// Helper function to check if location is in Delhi area
const isDelhiArea = async (location: {
  address: string;
  lat: number;
  lng: number;
}): Promise<boolean> => {
  // Define Delhi area center (approximate)
  const delhiCenter = { lat: 28.6139, lng: 77.209 };

  // Calculate distance from Delhi center
  const delhiDistance = calculateHaversineDistance(
    location.lat,
    location.lng,
    delhiCenter.lat,
    delhiCenter.lng
  );

  // Return true if location is within 50km of Delhi center
  return delhiDistance <= 50;
};

// Helper function to calculate distance between two coordinates using Haversine formula
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper function to calculate base price for Chardham Yatra
function calculateChardhamBasePrice(
  vehicleType: string,
  pickupArea: string,
  numberOfDhams: number
): number {
  // Get rates for vehicle
  const rates = VENDOR_RATES.CHARDHAM_YATRA[vehicleType];
  if (!rates) {
    throw new Error(`Invalid vehicle type: ${vehicleType}`);
  }

  let baseFare = 0;

  // Calculate base fare based on pickup area
  if (pickupArea === "haridwar" && rates.haridwar) {
    baseFare = rates.haridwar;
  } else if (pickupArea === "delhi" && rates.delhi) {
    baseFare = rates.delhi;
  } else {
    // For other pickup locations, calculate based on distance
    // Distance is set based on number of dhams
    let distance = 0;
    switch (numberOfDhams) {
      case 1:
        distance = 550;
        break;
      case 2:
        distance = 750;
        break;
      case 3:
        distance = 950;
        break;
      case 4:
        distance = 1250;
        break;
      default:
        distance = 1250;
    }

    // Calculate fare based on per-km rate
    if (vehicleType.startsWith("tempo_")) {
      // For tempo vehicles, determine base and extra charges
      const baseDistance = 250;
      if (distance <= baseDistance) {
        baseFare = rates.haridwar; // Use Haridwar rate as base for shorter distances
      } else {
        baseFare = rates.haridwar + (distance - baseDistance) * rates.extra;
      }
    } else {
      // For other vehicles, use per-km rate
      baseFare = distance * rates.base;
    }
  }

  // Adjust pricing based on number of dhams (for cases not from Delhi/Haridwar)
  if (pickupArea === "other") {
    switch (numberOfDhams) {
      case 1:
        baseFare = baseFare * 0.5;
        break; // 50% for 1 dham
      case 2:
        baseFare = baseFare * 0.7;
        break; // 70% for 2 dhams
      case 3:
        baseFare = baseFare * 0.85;
        break; // 85% for 3 dhams
      default:
        break; // 100% for 4 dhams
    }
  }

  return Math.round(baseFare);
}

// Modify the main calculation function to include Chardham handling
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
      // For Chardham, the calculation is done in calculateChardhamBasePrice
      // This branch should not be reached when calling from Chardham endpoints
      if (vehicleType.startsWith("tempo_")) {
        baseFare = rate.haridwar; // Use Haridwar rate as base
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
