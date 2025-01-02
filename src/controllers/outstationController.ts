import type { Request, Response } from "express";
import { PrismaClient, PaymentMode, OutstationTripType } from "@prisma/client";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";
import { io } from "../server";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

interface Location {
  address: string;
  lat: number;
  lng: number;
}

// Base rates for different vehicle categories
const VEHICLE_RATES = {
  mini: { base: 11, short: 14 },
  sedan: { base: 14, short: 19 },
  ertiga: { base: 18, short: 24 },
  innova: { base: 24, short: 27 },
  tempo_12: { fixed: 14000, extra: 23 },
  tempo_16: { fixed: 16000, extra: 26 },
  tempo_20: { fixed: 18000, extra: 30 },
  tempo_26: { fixed: 20000, extra: 35 },
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
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    tripType: OutstationTripType;
    vehicleType: string;
  } = req.body;

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    let fare = calculateOutstationFare(distance, vehicleType, tripType);

    res.json({
      estimate: {
        fare,
        distance,
        duration,
        currency: "INR",
        tripType,
        vehicleType,
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
  tripType: string
): number {
  let fare = 0;
  //@ts-ignore
  const rates = VEHICLE_RATES[vehicleType];

  if (vehicleType.startsWith("tempo_")) {
    // For tempo vehicles (round trip only)
    if (tripType === "ROUND_TRIP") {
      fare = rates.fixed;
      if (distance > 250) {
        const extraKm = distance - 250;
        fare += extraKm * rates.extra;
      }
    }
  } else {
    // For cars
    const ratePerKm = distance <= 150 ? rates.short : rates.base;
    fare = distance * ratePerKm;

    if (tripType === "ROUND_TRIP") {
      fare *= 2;
    }

    // Add 12% commission
    fare += fare * 0.12;
  }

  return Math.round(fare);
}

export const searchOutstationDrivers = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    tripType,
    paymentMode,
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    tripType: string;
    paymentMode: PaymentMode;
  } = req.body;

  // @ts-ignore
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    const fare = calculateOutstationFare(distance, vehicleType, tripType);

    const booking = await prisma.longDistanceBooking.create({
      data: {
        userId: (req as any).user.userId,
        serviceType: "OUTSTATION",
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
        paymentMode: paymentMode || PaymentMode.CASH,
        startDate: new Date(),
        endDate: new Date(),
        pickupTime: new Date().toISOString(),
        totalDays: 1,
        baseAmount: fare,
        taxAmount: 0,
        totalAmount: fare,
        advanceAmount: fare * 0.25,
        remainingAmount: fare * 0.75,
        status: "PENDING",
      },
    });

    const availableDrivers = await prisma.driverDetails.findMany({
      where: {
        vehicleCategory: vehicleType,
      },
      include: {
        user: true,
      },
    });

    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() + 1);

    res.json({
      booking,
      availableDrivers: availableDrivers.length,
      expiresAt: expiryTime,
      estimate: {
        distance,
        duration,
        fare,
        paymentMode,
        advanceAmount: fare * 0.25,
        remainingAmount: fare * 0.75,
      },
    });
  } catch (error) {
    console.error("Error searching drivers:", error);
    res.status(500).json({ error: "Failed to search drivers" });
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

// Create payment order for advance payment
export const createAdvancePayment = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        userId: req.user.userId, // Ensure booking belongs to user
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(booking.advanceAmount * 100),
      currency: "INR",
      receipt: bookingId,
    });

    res.json({ order });
  } catch (error) {
    console.error("Error creating payment:", error);
    res.status(500).json({ error: "Failed to create payment" });
  }
};

// Verify advance payment
export const verifyAdvancePayment = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    // Verify the payment signature first
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const updatedBooking = await prisma.$transaction(async (prisma) => {
      // 1. Update booking status
      const updatedBooking = await prisma.longDistanceBooking.update({
        where: {
          id: bookingId,
          userId: req.user!.userId,
        },
        data: {
          status: "ADVANCE_PAID",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
        },
      });

      // 2. Create transaction record
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: updatedBooking.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: updatedBooking.userId,
          receiverId: updatedBooking.driverId!,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for outstation taxisure ride ${bookingId}`,
          metadata: {
            bookingId,
            paymentMode: updatedBooking.paymentMode,

            advanceAmount: updatedBooking.advanceAmount,
            remainingAmount: updatedBooking.remainingAmount,
            totalAmount: updatedBooking.totalAmount,
          },
        },
      });

      // 3. Get or create driver's wallet
      const driverWallet = await prisma.wallet.upsert({
        where: {
          userId: updatedBooking.driverId!,
        },
        create: {
          userId: updatedBooking.driverId!,
          balance: updatedBooking.advanceAmount,
        },
        update: {
          balance: {
            increment: updatedBooking.advanceAmount,
          },
        },
      });

      return updatedBooking;
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
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
        status: "ADVANCE_PAID",
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
  if (!req.user?.userId) {
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

    const cancellationFee = 500; // Fixed cancellation fee

    const updatedBooking = await prisma.$transaction(async (prisma) => {
      // Update booking status
      const updated = await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelReason: reason,
        },
      });

      // Handle cancellation fee transaction if applicable
      if (booking.status !== "PENDING") {
        await prisma.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: cancellationFee,
            type: "REFUND",
            status: "COMPLETED",
            senderId: req.user?.userId,
            receiverId:
              req.user?.userId === booking.userId
                ? booking.driverId!
                : booking.userId,
            description: "Cancellation fee",
          },
        });

        // Update wallet of the receiving party
        await prisma.wallet.update({
          where: {
            userId:
              req.user?.userId === booking.userId
                ? booking.driverId!
                : booking.userId,
          },
          data: {
            balance: {
              increment: cancellationFee,
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

// Get available bookings for driver
export const getAvailableBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    // Get driver's vehicle category
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driverDetails) {
      return res.status(404).json({ error: "Driver details not found" });
    }

    // Get current time
    const now = new Date();

    // Find all pending bookings matching driver's vehicle category
    const availableBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "PENDING",
        vehicleCategory: driverDetails.vehicleCategory ?? "",
        driverId: { equals: null },
        createdAt: {
          gte: new Date(now.getTime() - 60 * 60 * 1000),
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
    const formattedBookings = availableBookings.map((booking) => ({
      id: booking.id,
      serviceType: booking.serviceType,
      tripType: booking.tripType,
      pickupLocation: booking.pickupLocation,
      distance: booking.distance,
      duration: booking.duration,

      dropLocation: booking.dropLocation,
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
      // Calculate time remaining for acceptance
      expiresIn: Math.max(
        0,
        60 -
          Math.floor(
            (now.getTime() - booking.createdAt.getTime()) / (1000 * 60)
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

      // Timestamps
      createdAt: booking.createdAt,
      driverAcceptedAt: booking.driverAcceptedAt,
      advancePaidAt: booking.advancePaidAt,
      driverArrivedAt: booking.driverArrivedAt,
      rideStartedAt: booking.rideStartedAt,
      rideEndedAt: booking.rideEndedAt,

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

      // 2. Create transaction record
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
          //  more than 40 length
          description: `Final payment for outstation taxisure ride ${booking.id}`,

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
