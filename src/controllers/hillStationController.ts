import { PaymentMode, PrismaClient } from "@prisma/client";
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

// Base rates for different vehicle categories
const HILL_STATION_RATES = {
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

interface Location {
  address: string;
  lat: number;
  lng: number;
}

export const getHillStationFareEstimate = async (
  req: Request,
  res: Response
) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
  } = req.body;

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    let fare = calculateHillStationFare(distance, vehicleType.toLowerCase());

    // Get features based on vehicle type

    res.json({
      estimate: {
        fare,
        distance,
        duration,
        currency: "INR",
        vehicleType,
      },
    });
  } catch (error) {
    console.error("Error in hill station fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

function calculateHillStationFare(
  distance: number,
  vehicleType: string
): { baseFare: number; commission: number; totalFare: number } {
  const normalizedVehicleType = vehicleType.toLowerCase();
  //@ts-ignore
  const rates = HILL_STATION_RATES[normalizedVehicleType];

  if (!rates) {
    throw new Error(`Invalid vehicle type: ${vehicleType}`);
  }

  let baseFare = 0;

  if (normalizedVehicleType.startsWith("tempo_")) {
    // For tempo vehicles
    baseFare = rates.fixed;
    if (distance > 250) {
      const extraKm = distance - 250;
      baseFare += extraKm * rates.extra;
    }
    return {
      baseFare: Math.round(baseFare),
      commission: 0, // No commission for tempo vehicles
      totalFare: Math.round(baseFare),
    };
  } else {
    // For cars (mini, sedan, ertiga, innova)
    baseFare = distance * rates.base;
    const commission = baseFare * 0.12; // 12% commission
    return {
      baseFare: Math.round(baseFare),
      commission: Math.round(commission),
      totalFare: Math.round(baseFare - commission),
    };
  }
}

export const searchHillStationDrivers = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    paymentMode,
    startDate,
    endDate,
    pickupTime,
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    paymentMode: PaymentMode;
    startDate: string;
    endDate: string;
    pickupTime: string;
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

    const { baseFare, commission, totalFare } = calculateHillStationFare(
      distance,
      vehicleType
    );
    const totalDays = Math.ceil(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        (1000 * 60 * 60 * 24)
    );

    const booking = await prisma.longDistanceBooking.create({
      data: {
        // @ts-ignore
        userId: req.user.userId,
        serviceType: "HILL_STATION",
        pickupLocation: pickupLocation.address,
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        dropLocation: dropLocation.address,
        dropLat: dropLocation.lat,
        dropLng: dropLocation.lng,
        vehicleCategory: vehicleType,
        distance,
        duration,
        paymentMode: paymentMode || PaymentMode.CASH,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        pickupTime,
        totalDays,
        baseAmount: baseFare,
        commission: commission,
        totalAmount: totalFare,
        taxAmount: 0,
        advanceAmount: totalFare * 0.25,
        remainingAmount: totalFare * 0.75,
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

    // Get features based on vehicle type
    const features = vehicleType.startsWith("tempo_")
      ? ["Per day limit: 250 km", "Driver allowance included", "Fuel included"]
      : [
          "Per km pricing",
          "Driver allowance included",
          "Fuel included",
          "12% commission included",
        ];

    res.json({
      booking,
      availableDrivers: availableDrivers.length,
      expiresAt: expiryTime,
      estimate: {
        distance,
        duration,
        fare: totalFare,
        paymentMode,
        advanceAmount: totalFare * 0.25,
        remainingAmount: totalFare * 0.75,
        features,
        totalDays,
      },
    });
  } catch (error) {
    console.error("Error searching drivers:", error);
    res.status(500).json({ error: "Failed to search drivers" });
  }
};

// New endpoints for hill station flow
export const acceptHillStationBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    // Check if driver has paid registration fee
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driverDetails || !driverDetails.registrationFeePaid) {
      return res.status(403).json({
        error:
          "Registration fee not paid. Please pay the registration fee to accept bookings.",
      });
    }

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

export const createAdvancePayment = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        userId: req.user.userId,
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(booking.advanceAmount * 100),
      currency: "INR",
      receipt: `H${bookingId.slice(-8)}`,
      notes: {
        bookingId: bookingId,
        userId: req.user.userId,
        type: "hill_station_advance_payment",
      },
    });

    res.json({ order });
  } catch (error) {
    console.error("Error creating payment:", error);
    res.status(500).json({ error: "Failed to create payment" });
  }
};

export const verifyAdvancePayment = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const updatedBooking = await prisma.$transaction(async (prisma) => {
      const updated = await prisma.longDistanceBooking.update({
        where: {
          id: bookingId,
          userId: req.user!.userId,
        },
        data: {
          status: "ADVANCE_PAID",
          advancePaymentStatus: "COMPLETED",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
        },
      });

      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: updated.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: updated.userId,
          receiverId: updated.driverId!,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for hill station ride ${bookingId}`,
          metadata: {
            bookingId,
            paymentMode: updated.paymentMode,
            advanceAmount: updated.advanceAmount,
            remainingAmount: updated.remainingAmount,
            totalAmount: updated.totalAmount,
          },
        },
      });

      await prisma.wallet.upsert({
        where: { userId: updated.driverId! },
        create: {
          userId: updated.driverId!,
          balance: updated.advanceAmount,
        },
        update: {
          balance: { increment: updated.advanceAmount },
        },
      });

      return updated;
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

    // Notify user through socket
    io.to(booking.userId).emit("driver_pickup_started", {
      bookingId,
      driverId: req.user.userId,
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

    // Notify user through socket
    io.to(booking.userId).emit("driver_arrived", {
      bookingId,
      driverId: req.user.userId,
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

    // Notify user through socket
    io.to(booking.userId).emit("ride_started", {
      bookingId,
      driverId: req.user.userId,
    });

    res.json({ booking: updatedBooking });
  } catch (error) {
    console.error("Error starting ride:", error);
    res.status(500).json({ error: "Failed to start ride" });
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
    const shortReceiptId = `HF${bookingId.slice(-8)}`;

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(booking.remainingAmount * 100),
      currency: "INR",
      receipt: shortReceiptId,
      notes: {
        bookingId: bookingId,
        userId: req.user.userId,
        type: "hill_station_final_payment",
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

    // Handle Razorpay payment verification
    if (paymentMode === "RAZORPAY") {
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
          description: `Final payment for hill station ride ${bookingId}`,
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

      await prisma.wallet.upsert({
        where: { userId: booking.driverId! },
        create: {
          userId: booking.driverId!,
          balance: booking.remainingAmount,
        },
        update: {
          balance: { increment: booking.remainingAmount },
        },
      });

      return completed;
    });

    // Notify both parties through socket
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

// Get booking status

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

    io.to(booking.driverId!).emit("ride_cancelled", {
      bookingId,
      reason,
    });

    io.to(booking.userId).emit("ride_cancelled", {
      bookingId,
      reason,
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
};
// Get available bookings for drivers
export const getAvailableBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const availableBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "PENDING",
        serviceType: "HILL_STATION",
        driverId: null,
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

    res.json({
      availableBookings,
      count: availableBookings.length,
    });
  } catch (error) {
    console.error("Error fetching available bookings:", error);
    res.status(500).json({ error: "Failed to fetch available bookings" });
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
        serviceType: "HILL_STATION",
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

    const formattedBookings = acceptedBookings.map((booking) => ({
      id: booking.id,
      serviceType: booking.serviceType,
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
