import type { Request, Response } from "express";
import { PrismaClient, PaymentMode } from "@prisma/client";
import Razorpay from "razorpay";
import crypto from "crypto";
import { io } from "../server";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";

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

// Base rates for different vehicle categories for All India Tour
const ALL_INDIA_RATES = {
  mini: { perDay: 3000, extraKm: 16 },
  sedan: { perDay: 3500, extraKm: 19 },
  ertiga: { perDay: 4800, extraKm: 21 },
  innova: { perDay: 5600, extraKm: 22 },
  tempo_12: { perDay: 7000, extraKm: 23 },
  tempo_16: { perDay: 8000, extraKm: 26 },
  tempo_20: { perDay: 9000, extraKm: 30 },
  tempo_26: { perDay: 10000, extraKm: 35 },
};

export const getAllIndiaFareEstimate = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    startDate: string;
    endDate: string;
    pickupTime: string;
  } = req.body;

  try {
    const { distance } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    // Parse dates and time
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);

    // Create start datetime with pickup time
    const startDateTime = new Date(startDate);
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    // Create end datetime with same pickup time
    const endDateTime = new Date(endDate);
    endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    // Calculate total days (including partial days)
    const timeDiff = endDateTime.getTime() - startDateTime.getTime();
    const daysDiff = timeDiff / (1000 * 3600 * 24);
    const numberOfDays = Math.ceil(daysDiff) || 1; // Minimum 1 day

    // Get rates for vehicle type
    //@ts-ignore
    const rates = ALL_INDIA_RATES[vehicleType];
    if (!rates) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    // Calculate base fare (per day rate * number of days)
    const baseFare = rates.perDay * numberOfDays;

    // Calculate extra distance fare
    const allowedDistance = 250 * numberOfDays; // 250 km per day
    const extraDistance = Math.max(0, distance - allowedDistance);
    const extraDistanceFare = extraDistance * rates.extraKm;

    // Calculate total fare
    const totalFare = baseFare + extraDistanceFare;

    // Calculate advance amount (25%) and remaining amount (75%)
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    res.json({
      estimate: {
        baseFare,
        extraDistanceFare,
        totalFare,
        advanceAmount,
        remainingAmount,
        distance,
        numberOfDays,
        allowedDistance,
        extraDistance,
        perDayRate: rates.perDay,
        extraKmRate: rates.extraKm,
        currency: "INR",
        vehicleType,
        tripDetails: {
          startDateTime: startDateTime.toISOString(),
          endDateTime: endDateTime.toISOString(),
          pickupTime,
          totalDays: numberOfDays,
        },
        details: {
          perDayKmLimit: 250,
          includedInFare: ["Fuel charges", "Vehicle rental", "Driver charges"],
          excludedFromFare: [
            "State tax",
            "Toll tax",
            "Parking charges",
            "Driver allowance",
            "Night charges",
          ],
          paymentBreakdown: {
            advancePayment: {
              percentage: 25,
              amount: advanceAmount,
            },
            remainingPayment: {
              percentage: 75,
              amount: remainingAmount,
            },
          },
        },
      },
    });
  } catch (error) {
    console.error("Error in all india fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

export const createAllIndiaBooking = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
    paymentMode,
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    startDate: string;
    endDate: string;
    pickupTime: string;
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

    // Parse dates and calculate total days
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = new Date(startDate);
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    const endDateTime = new Date(endDate);
    endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    const numberOfDays =
      Math.ceil(
        (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 3600 * 24)
      ) || 1;

    // Calculate fare
    //@ts-ignore
    const rates = ALL_INDIA_RATES[vehicleType];
    const baseFare = rates.perDay * numberOfDays;
    const allowedDistance = 250 * numberOfDays;
    const extraDistance = Math.max(0, distance - allowedDistance);
    const extraDistanceFare = extraDistance * rates.extraKm;
    const totalFare = baseFare + extraDistanceFare;
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    // Create booking
    const booking = await prisma.longDistanceBooking.create({
      data: {
        userId: req.user.userId,
        serviceType: "ALL_INDIA_TOUR",
        pickupLocation: pickupLocation.address,
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        dropLocation: dropLocation.address,
        dropLat: dropLocation.lat,
        dropLng: dropLocation.lng,
        vehicleCategory: vehicleType,
        distance,
        duration,
        paymentMode,
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime: pickupTime,
        totalDays: numberOfDays,
        baseAmount: baseFare,
        totalAmount: totalFare,
        advanceAmount,
        remainingAmount,
        taxAmount: 0,
        status: "PENDING",
      },
    });

    // Find available drivers
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
        totalFare,
        paymentMode,
        advanceAmount,
        remainingAmount,
        numberOfDays,
        allowedDistance,
        extraDistance,
      },
    });
  } catch (error) {
    console.error("Error creating All India booking:", error);
    res.status(500).json({ error: "Failed to create booking" });
  }
};

export const getAvailableAllIndiaBookings = async (
  req: Request,
  res: Response
) => {
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

    const now = new Date();
    const availableBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "PENDING",
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: driverDetails.vehicleCategory ?? "",
        driverId: null,
        createdAt: {
          gte: new Date(now.getTime() - 60 * 60 * 1000), // Last hour
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

    const formattedBookings = availableBookings.map((booking) => ({
      id: booking.id,
      pickupLocation: booking.pickupLocation,
      dropLocation: booking.dropLocation,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
      totalDays: booking.totalDays,
      distance: booking.distance,
      totalAmount: booking.totalAmount,
      advanceAmount: booking.advanceAmount,
      remainingAmount: booking.remainingAmount,
      paymentMode: booking.paymentMode,
      createdAt: booking.createdAt,
      user: {
        name: booking.user.name,
        phone: booking.user.phone,
      },
      expiresIn: Math.max(
        0,
        60 -
          Math.floor(
            (now.getTime() - booking.createdAt.getTime()) / (1000 * 60)
          )
      ),
    }));

    res.json({
      availableBookings: formattedBookings,
      count: formattedBookings.length,
    });
  } catch (error) {
    console.error("Error fetching available All India bookings:", error);
    res.status(500).json({ error: "Failed to fetch available bookings" });
  }
};

// Driver accepts booking
export const acceptAllIndiaBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const booking = await prisma.longDistanceBooking.update({
      where: {
        id: bookingId,
        status: "PENDING",
      },
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
        userId: req.user.userId,
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
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const updatedBooking = await prisma.$transaction(async (prisma) => {
      const booking = await prisma.longDistanceBooking.update({
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
          amount: booking.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: booking.userId,
          receiverId: booking.driverId!,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for All India Tour ${bookingId}`,
        },
      });

      await prisma.wallet.upsert({
        where: { userId: booking.driverId! },
        create: {
          userId: booking.driverId!,
          balance: booking.advanceAmount,
        },
        update: {
          balance: { increment: booking.advanceAmount },
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

// Driver starts journey to pickup
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

// Driver arrived at pickup
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
        otp: Math.floor(1000 + Math.random() * 9000).toString(),
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

    if (!booking || booking.otp !== otp) {
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

    if (
      booking.userId !== req.user.userId &&
      booking.driverId !== req.user.userId
    ) {
      return res
        .status(403)
        .json({ error: "Unauthorized to cancel this booking" });
    }

    const updatedBooking = await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        status: "CANCELLED",
        cancelReason: reason,
      },
    });

    // Notify both parties through socket
    io.to(booking.userId).emit("booking_cancelled", {
      bookingId,
      reason,
      cancelledBy: req.user.userType,
      serviceType: "ALL_INDIA_TOUR",
    });

    if (booking.driverId) {
      io.to(booking.driverId).emit("booking_cancelled", {
        bookingId,
        reason,
        cancelledBy: req.user.userType,
        serviceType: "ALL_INDIA_TOUR",
      });
    }

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ error: "Failed to cancel booking" });
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
      serviceType: "ALL_INDIA_TOUR",
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

    const shortReceiptId = `F${bookingId.slice(-8)}`;
    const order = await razorpay.orders.create({
      amount: Math.round(booking.remainingAmount * 100),
      currency: "INR",
      receipt: shortReceiptId,
      notes: {
        bookingId: bookingId,
        userId: req.user.userId,
        type: "all_india_final_payment",
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

      // Verify payment amount
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
          description: `Final payment for All India Tour ${booking.id}`,
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
      serviceType: "ALL_INDIA_TOUR",
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
      serviceType: "ALL_INDIA_TOUR",
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
