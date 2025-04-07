import {
  LongDistanceServiceType,
  OutstationTripType,
  PaymentMode,
  PrismaClient,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { io } from "../server";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";
const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

console.log(process.env.DATABASE_URL);
interface Location {
  address: string;
  lat: number;
  lng: number;
}

// Define types for the rate objects
type TempoRate = {
  fixed: number;
  extra: number;
};

type CarRate = {
  base: number;
};

type OutstationCarRate = {
  base: number;
  short: number;
};

// Define the rate objects with proper typing
const VEHICLE_RATES: Record<string, OutstationCarRate | TempoRate> = {
  mini: { base: 11, short: 14 },
  sedan: { base: 14, short: 19 },
  ertiga: { base: 18, short: 24 },
  innova: { base: 24, short: 27 },
  tempo_12: { fixed: 14000, extra: 23 },
  tempo_16: { fixed: 16000, extra: 26 },
  tempo_20: { fixed: 18000, extra: 30 },
  tempo_26: { fixed: 20000, extra: 35 },
};

const HILL_STATION_RATES: Record<string, CarRate | TempoRate> = {
  // Tempo rates
  tempo_12: { fixed: 7000, extra: 23 },
  tempo_16: { fixed: 8000, extra: 26 },
  tempo_20: { fixed: 9000, extra: 30 },
  tempo_26: { fixed: 10000, extra: 35 },
  // Car rates
  mini: { base: 20 },
  sedan: { base: 27 },
  ertiga: { base: 30 },
  innova: { base: 35 },
};

export const getOutstationFareEstimate = async (
  req: Request,
  res: Response
) => {
  const {
    pickupLocation,
    dropLocation,
    tripType,
    vehicleType,
    serviceType = "OUTSTATION",
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    tripType: OutstationTripType;
    vehicleType: string;
    serviceType?: LongDistanceServiceType;
  } = req.body;

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    // Validate minimum distance for hill station (e.g., 10km)
    if (serviceType === "HILL_STATION" && distance < 10) {
      return res.status(400).json({
        error: "Hill station bookings require minimum 50km distance",
      });
    }

    let fare = calculateOutstationFare(
      distance,
      vehicleType,
      tripType,
      serviceType
    );

    res.json({
      estimate: {
        fare,
        distance,
        duration,
        currency: "INR",
        tripType,
        vehicleType,
        serviceType,
      },
    });
  } catch (error) {
    console.error("Error in outstation fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

function calculateOutstationFare(
  distance: number,
  vehicleType: string,
  tripType: string,
  serviceType: LongDistanceServiceType = "OUTSTATION"
): number {
  let fare = 0;
  const rates =
    serviceType === "HILL_STATION"
      ? HILL_STATION_RATES[vehicleType]
      : VEHICLE_RATES[vehicleType];

  if (!rates) {
    throw new Error("Invalid vehicle type");
  }

  if (vehicleType.startsWith("tempo_")) {
    // For tempo vehicles (round trip only)
    if (tripType === "ROUND_TRIP") {
      const tempoRates = rates as TempoRate;
      fare = tempoRates.fixed;
      if (distance > 250) {
        const extraKm = distance - 250;
        fare += extraKm * tempoRates.extra;
      }
    }
  } else {
    // For cars
    if (serviceType === "HILL_STATION") {
      const hillRates = rates as CarRate;
      fare = distance * hillRates.base;
    } else {
      const outstationRates = rates as OutstationCarRate;
      const ratePerKm =
        distance <= 150 ? outstationRates.short : outstationRates.base;
      fare = distance * ratePerKm;
    }

    if (tripType === "ROUND_TRIP") {
      fare *= 2;
    }
  }

  return Math.round(fare);
}

export const searchOutstationDrivers = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    tripType,
    serviceType = "OUTSTATION", // Default to outstation if not specified
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    tripType: string;
    serviceType?: LongDistanceServiceType;
    paymentMode: PaymentMode;
  } = req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    const fare = calculateOutstationFare(
      distance,
      vehicleType,
      tripType,
      serviceType
    );

    // Calculate app commission (12% of total fare)
    const commission = Math.round(fare * 0.12);
    const driverEarnings = fare - commission;

    const booking = await prisma.longDistanceBooking.create({
      data: {
        userId: req.user.userId,
        serviceType, // Use the provided service type
        pickupLocation: pickupLocation.address,
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        dropLocation: dropLocation.address,
        dropLat: dropLocation.lat,
        dropLng: dropLocation.lng,
        vehicleCategory: vehicleType,
        tripType: tripType as OutstationTripType,
        distance,
        duration,
        paymentMode: PaymentMode.RAZORPAY,
        startDate: new Date(),
        endDate: new Date(),
        pickupTime: new Date().toISOString(),
        totalDays: 1,
        baseAmount: fare,
        taxAmount: 0,
        totalAmount: fare,
        advanceAmount: fare * 0.25,
        remainingAmount: fare * 0.75,
        commission: commission, // Store the commission amount
        status: "PENDING",
      },
    });

    // Create Razorpay order for advance payment
    const order = await razorpay.orders.create({
      amount: Math.round(booking.advanceAmount * 100),
      currency: "INR",
      receipt: `ADV${booking.id.slice(-8)}`,
      notes: {
        bookingId: booking.id,
        userId: req.user.userId,
        type: `${serviceType.toLowerCase()}_advance_payment`,
      },
    });

    res.json({
      booking,
      paymentDetails: {
        order,
        amount: booking.advanceAmount,
      },
      estimate: {
        distance,
        duration,
        fare,
        advanceAmount: booking.advanceAmount,
        remainingAmount: booking.remainingAmount,
        commission,
        driverEarnings,
      },
    });
  } catch (error) {
    console.error("Error creating booking:", error);
    res.status(500).json({ error: "Failed to create booking" });
  }
};

// Verify advance payment and make booking available to drivers
export const verifyAdvancePayment = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
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
      // First get the booking to access the serviceType
      const booking = await prisma.longDistanceBooking.update({
        where: {
          id: bookingId,
          userId: req.user!.userId,
        },
        data: {
          status: "ADVANCE_PAID",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
          advancePaymentStatus: "COMPLETED",
        },
      });

      // Create transaction record with dynamic service type
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: booking.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: booking.userId,
          receiverId: null,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for ${booking.serviceType.toLowerCase()} ride ${bookingId}`,
        },
      });

      return booking;
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
};

// Driver accepts booking
export const acceptOutstationBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
        driverAcceptedAt: new Date(),
      },
    });

    res.json({ booking });
  } catch (error) {
    console.error("Error accepting booking:", error);
    res.status(500).json({ error: "Failed to accept booking" });
  }
};

// Driver starts journey to pickup location
export const startDriverPickup = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.longDistanceBooking.update({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
      },
      data: {
        status: "DRIVER_PICKUP_STARTED",
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
    const booking = await prisma.longDistanceBooking.update({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_PICKUP_STARTED",
      },
      data: {
        status: "DRIVER_ARRIVED",
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
export const startRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { otp } = req.body;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_ARRIVED",
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (booking.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const updatedBooking = await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        status: "STARTED",
        rideStartedAt: new Date(),
      },
    });

    res.json({ booking: updatedBooking });
  } catch (error) {
    console.error("Error starting ride:", error);
    res.status(500).json({ error: "Failed to start ride" });
  }
};

// Cancel booking
export const cancelBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { reason } = req.body;

  if (!req.user?.userId || !req.user?.userType) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Check if user is authorized to cancel (either user or driver)
    if (
      booking.userId !== req.user.userId &&
      booking.driverId !== req.user.userId
    ) {
      return res
        .status(403)
        .json({ error: "Unauthorized to cancel this booking" });
    }

    const cancellationFee = 300; // Fixed cancellation fee

    // Use a transaction to update booking and handle cancellation fee if applicable.
    const updatedBooking = await prisma.$transaction(async (tx) => {
      // Update booking status to CANCELLED with the provided reason.
      const updated = await tx.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelReason: reason,
          cancelledBy: req.user!.userType === "USER" ? "USER" : "DRIVER",
          cancelledAt: new Date(),
        },
      });

      /**
       * Process cancellation fee transaction only if:
       * - The booking is not in the initial PENDING state AND
       * - A driver is assigned.
       *
       * This ensures that if the advance is paid but no driver is assigned,
       * the cancellation fee logic is bypassed.
       */
      if (booking.status !== "PENDING" && booking.driverId) {
        // Determine who is cancelling and who should receive the fee
        const isUserCancelling = req.user!.userId === booking.userId;
        const senderId = isUserCancelling ? booking.userId : booking.driverId;
        const receiverId = isUserCancelling ? booking.driverId : booking.userId;

        // Get sender's wallet
        const senderWallet = await tx.wallet.upsert({
          where: { userId: senderId },
          create: { userId: senderId, balance: -cancellationFee },
          update: { balance: { decrement: cancellationFee } },
        });

        // Get or create receiver's wallet
        const receiverWallet = await tx.wallet.upsert({
          where: { userId: receiverId },
          create: { userId: receiverId, balance: cancellationFee },
          update: { balance: { increment: cancellationFee } },
        });

        // Create transaction record for the cancellation fee
        await tx.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: cancellationFee,
            type: "REFUND",
            status: "COMPLETED",
            senderId,
            receiverId,
            description: `Cancellation fee - ${isUserCancelling ? "User" : "Driver"} cancelled the booking`,
            metadata: {
              cancellationFee,
              cancelledBy: isUserCancelling ? "USER" : "DRIVER",
              senderWalletBalance: senderWallet.balance,
              receiverWalletBalance: receiverWallet.balance,
            },
          },
        });
      }

      return updated;
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
};

// Get available bookings for driver (only show ADVANCE_PAID bookings)
export const getAvailableBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driverDetails) {
      return res.status(404).json({ error: "Driver details not found" });
    }

    // Find bookings that are paid and match driver's vehicle category
    const availableBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "ADVANCE_PAID", // Only show paid bookings
        vehicleCategory: driverDetails.vehicleCategory ?? "",
        driverId: null, // Not yet accepted by any driver
      },
      include: {
        user: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Format response
    const formattedBookings = availableBookings.map((booking) => ({
      id: booking.id,
      serviceType: booking.serviceType,
      tripType: booking.tripType,
      pickupLocation: booking.pickupLocation,
      distance: booking.distance,
      duration: booking.duration,
      vehicleCategory: booking.vehicleCategory,
      dropLocation: booking.dropLocation,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
      totalDays: booking.totalDays,
      baseAmount: booking.baseAmount,
      totalAmount: booking.totalAmount,
      driverEarnings: booking.totalAmount - booking.commission, // Show driver earnings after commission
      commission: booking.commission, // Show commission amount
      advanceAmount: booking.advanceAmount,
      remainingAmount: booking.remainingAmount,
      paymentMode: booking.paymentMode,
      createdAt: booking.createdAt,
      user: {
        name: booking.user.name,
        phone: booking.user.phone,
      },
      // Calculate time remaining for acceptance
      expiresIn: Math.max(
        0,
        60 -
          Math.floor(
            (new Date().getTime() - booking.createdAt.getTime()) / (1000 * 60)
          )
      ), // minutes remaining
    }));

    res.json({
      availableBookings: formattedBookings,
      count: formattedBookings.length,
    });
  } catch (error) {
    console.error("Error fetching available bookings:", error);
    res.status(500).json({ error: "Failed to fetch available bookings" });
  }
};

export const getBookingStatus = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        OR: [{ userId: req.user.userId }, { driverId: req.user.userId }],
      },
      include: {
        user: {
          select: {
            name: true,
            phone: true,
          },
        },
        driver: {
          select: {
            name: true,
            phone: true,
            email: true,
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
                vehicleCategory: true,
              },
            },
            driverStatus: {
              select: {
                locationLat: true,
                locationLng: true,
                lastLocationUpdate: true,
              },
            },
          },
        },
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Calculate driver's earnings after commission
    const driverEarnings = booking.totalAmount - booking.commission;

    // Format response based on user type
    const response = {
      id: booking.id,
      status: booking.status,
      serviceType: booking.serviceType,
      tripType: booking.tripType,
      pickupLocation: {
        address: booking.pickupLocation,
        lat: booking.pickupLat,
        lng: booking.pickupLng,
      },
      dropLocation: {
        address: booking.dropLocation,
        lat: booking.dropLat,
        lng: booking.dropLng,
      },
      distance: booking.distance,
      duration: booking.duration,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
      totalDays: booking.totalDays,
      vehicleCategory: booking.vehicleCategory,

      // Payment details
      baseAmount: booking.baseAmount,
      totalAmount: booking.totalAmount,
      advanceAmount: booking.advanceAmount,
      remainingAmount: booking.remainingAmount,
      paymentMode: booking.paymentMode,
      advancePaymentStatus: booking.advancePaymentStatus,
      finalPaymentStatus: booking.finalPaymentStatus,

      // Commission details - only show to drivers
      ...(req.user.userType === "DRIVER" && {
        commission: booking.commission,
        driverEarnings: driverEarnings,
      }),

      // Timestamps
      createdAt: booking.createdAt,
      driverAcceptedAt: booking.driverAcceptedAt,
      advancePaidAt: booking.advancePaidAt,
      driverArrivedAt: booking.driverArrivedAt,
      rideStartedAt: booking.rideStartedAt,
      rideEndedAt: booking.rideEndedAt,
      cancelReason: booking.cancelReason,

      // User info (always included)
      user: {
        name: booking.user.name,
        phone: booking.user.phone,
      },

      // Driver info (included if assigned)
      driver: booking.driver
        ? {
            name: booking.driver.name,
            phone: booking.driver.phone,
            email: booking.driver.email,
            vechile: {
              vehicleName: booking.driver.driverDetails?.vehicleName,
              vehicleNumber: booking.driver.driverDetails?.vehicleNumber,
              vehicleCategory: booking.driver.driverDetails?.vehicleCategory,
            },
            currentLocation: booking.driver.driverStatus
              ? {
                  lat: booking.driver.driverStatus.locationLat,
                  lng: booking.driver.driverStatus.locationLng,
                  lastUpdate: booking.driver.driverStatus.lastLocationUpdate,
                }
              : null,
          }
        : null,

      // OTP (only included for specific statuses and roles)
      otp:
        req.user.userType === "USER" && booking.status === "DRIVER_ARRIVED"
          ? booking.otp
          : undefined,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching booking status:", error);
    res.status(500).json({ error: "Failed to fetch booking status" });
  }
};

// Driver initiates ride completion
export const initiateRideCompletion = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.longDistanceBooking.update({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "STARTED",
      },
      data: {
        status: "PAYMENT_PENDING",
      },
      include: {
        user: {
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
    });

    if (!booking) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status" });
    }

    // Notify user through socket

    io.to(booking.userId).emit("ride_completion_initiated", {
      bookingId,
      remainingAmount: booking.remainingAmount,
      driverDetails: {
        name: booking.driver?.name,
        phone: booking.driver?.phone,
      },
    });

    res.json({
      success: true,
      booking,
      message: "Ride completion initiated successfully",
    });
  } catch (error) {
    console.error("Error initiating ride completion:", error);
    res.status(500).json({ error: "Failed to initiate ride completion" });
  }
};

// User confirms ride completion
export const confirmRideCompletion = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const {
    paymentMode,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
  } = req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        userId: req.user.userId,
        status: "PAYMENT_PENDING",
      },
      include: {
        user: {
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
    });

    if (!booking) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status" });
    }

    // Handle Razorpay payment
    if (paymentMode === "RAZORPAY") {
      // Verify the payment signature
      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        return res.status(400).json({ error: "Missing payment details" });
      }

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_SECRET!)
        .update(body.toString())
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid payment signature" });
      }

      // Verify payment amount with Razorpay
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.amount !== Math.round(booking.remainingAmount * 100)) {
        return res.status(400).json({ error: "Payment amount mismatch" });
      }
    }

    // Use transaction to update booking, create transaction record, and update wallet
    const updatedBooking = await prisma.$transaction(async (prisma) => {
      // 1. Update booking status
      const completed = await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "COMPLETED",
          rideEndedAt: new Date(),
          finalPaymentMode: paymentMode,
          finalPaymentStatus: "COMPLETED",
          finalPaymentId: razorpay_payment_id || null,
        },
        include: {
          user: {
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
      });

      // 2. Create transaction record with dynamic service type
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: booking.remainingAmount,
          type: "BOOKING_FINAL",
          status: "COMPLETED",
          senderId: booking.userId,
          receiverId: booking.driverId!,
          razorpayOrderId: razorpay_order_id || null,
          razorpayPaymentId: razorpay_payment_id || null,
          description: `Final payment for ${booking.serviceType.toLowerCase()} ride ${bookingId}`,
          metadata:
            paymentMode === "CASH"
              ? { paymentType: "CASH", collectedBy: "DRIVER" }
              : {
                  paymentType: "RAZORPAY",
                  orderId: razorpay_order_id,
                  paymentId: razorpay_payment_id,
                },
        },
      });

      // 3. Update driver's wallet
      await prisma.wallet.upsert({
        where: {
          userId: booking.driverId!,
        },
        create: {
          userId: booking.driverId!,
          balance: booking.remainingAmount,
        },
        update: {
          balance: {
            increment: booking.remainingAmount,
          },
        },
      });

      return completed;
    });

    // Notify both parties through socket

    // Notify driver

    io.to(booking.driverId!).emit("ride_completed", {
      bookingId,
      paymentMode,
      paymentStatus: "COMPLETED",
      amount: booking.remainingAmount,
      userDetails: {
        name: booking.user?.name,
        phone: booking.user?.phone,
      },
    });

    // Notify user
    io.to(booking.userId).emit("ride_completed", {
      bookingId,
      paymentMode,
      paymentStatus: "COMPLETED",
      amount: booking.remainingAmount,
      driverDetails: {
        name: booking.driver?.name,
        phone: booking.driver?.phone,
      },
    });

    res.json({
      success: true,
      booking: updatedBooking,
      paymentDetails: {
        amount: booking.remainingAmount,
        mode: paymentMode,
        status: "COMPLETED",
        transactionId: razorpay_payment_id || null,
      },
    });
  } catch (error) {
    console.error("Error confirming ride completion:", error);
    res.status(500).json({ error: "Failed to confirm ride completion" });
  }
};

// Create Razorpay order for final payment
export const createFinalPaymentOrder = async (req: Request, res: Response) => {
  const { bookingId } = req.params;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        userId: req.user.userId,
        status: "PAYMENT_PENDING",
      },
    });

    if (!booking) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status" });
    }

    // Create a shorter receipt ID (using last 8 characters of bookingId)
    const shortReceiptId = `F${bookingId.slice(-8)}`;

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(booking.remainingAmount * 100),
      currency: "INR",
      receipt: shortReceiptId,
      notes: {
        bookingId: bookingId,
        userId: req.user.userId,
        type: "outstation_final_payment",
      },
    });

    res.json({
      success: true,
      order,
      booking: {
        id: booking.id,
        amount: booking.remainingAmount,
        currency: "INR",
      },
    });
  } catch (error) {
    console.error("Error creating payment order:", error);
    res.status(500).json({ error: "Failed to create payment order" });
  }
};

// Get accepted bookings for driver
export const getAcceptedBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const acceptedBookings = await prisma.longDistanceBooking.findMany({
      where: {
        driverId: req.user.userId,
        status: {
          in: [
            "DRIVER_ACCEPTED",
            "ADVANCE_PAID",
            "DRIVER_PICKUP_STARTED",
            "DRIVER_ARRIVED",
            "STARTED",
            "PAYMENT_PENDING",
            "COMPLETED",
          ],
        },
      },
      include: {
        user: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Format response with essential booking details
    const formattedBookings = acceptedBookings.map((booking) => ({
      id: booking.id,
      serviceType: booking.serviceType,
      tripType: booking.tripType,
      status: booking.status,
      pickupLocation: booking.pickupLocation,
      dropLocation: booking.dropLocation,
      distance: booking.distance,
      duration: booking.duration,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
      totalDays: booking.totalDays,
      baseAmount: booking.baseAmount,
      totalAmount: booking.totalAmount,
      advanceAmount: booking.advanceAmount,
      remainingAmount: booking.remainingAmount,
      paymentMode: booking.paymentMode,
      createdAt: booking.createdAt,
      user: {
        name: booking.user.name,
        phone: booking.user.phone,
      },
      // relevant timestamps
      driverAcceptedAt: booking.driverAcceptedAt,
      advancePaidAt: booking.advancePaidAt,
      driverArrivedAt: booking.driverArrivedAt,
      rideStartedAt: booking.rideStartedAt,
      rideEndedAt: booking.rideEndedAt,
    }));

    res.json({
      acceptedBookings: formattedBookings,
      count: formattedBookings.length,
    });
  } catch (error) {
    console.error("Error fetching accepted bookings:", error);
    res.status(500).json({ error: "Failed to fetch accepted bookings" });
  }
};
