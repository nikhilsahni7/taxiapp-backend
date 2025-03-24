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

interface Location {
  address: string;
  lat: number;
  lng: number;
}

// Updated base rates including tempo travellers
const ALL_INDIA_RATES = {
  mini: { baseFare: 2750, extraKm: 14 },
  sedan: { baseFare: 3500, extraKm: 16 },
  ertiga: { baseFare: 4500, extraKm: 16 },
  innova: { baseFare: 6000, extraKm: 18 },
  // Adding tempo traveller categories
  tempo_12: { baseFare: 7000, extraKm: 20 },
  tempo_16: { baseFare: 8000, extraKm: 22 },
  tempo_20: { baseFare: 9000, extraKm: 24 },
  tempo_26: { baseFare: 10000, extraKm: 26 },
};

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

export const getAllIndiaFareEstimate = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
  } = req.body;

  try {
    const { distance } = await getCachedDistanceAndDuration(
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
        (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 3600 * 24) +
          1
      ) || 1;

    // Get rates for vehicle type
    //@ts-ignore
    const rates = ALL_INDIA_RATES[vehicleType];
    if (!rates) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    // Calculate round trip distance
    const roundTripDistance = distance * 2;

    // Calculate allowed distance based on number of days
    const allowedDistance = 250 * numberOfDays;

    // Calculate base fare
    let baseFare = rates.baseFare * numberOfDays;

    // Calculate extra distance fare if applicable
    const extraDistance = Math.max(0, roundTripDistance - allowedDistance);
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
        distance: roundTripDistance,
        numberOfDays,
        allowedDistance,
        extraDistance,
        perDayRate: rates.baseFare,
        extraKmRate: rates.extraKm,
        currency: "INR",
        vehicleType,
        vehicleCapacity: getVehicleCapacity(vehicleType),
        tripDetails: {
          startDateTime: startDateTime.toISOString(),
          endDateTime: endDateTime.toISOString(),
          pickupTime,
          totalDays: numberOfDays,
        },
        details: {
          perDayKmLimit: 250,
          includedInFare: [
            "Driver charges",
            "Fuel charges",
            "Vehicle rental",
            `${allowedDistance} kms included`,
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
            `Extra km charges (₹${rates.extraKm}/km after ${allowedDistance} kms)`,
            vehicleType.includes("tempo")
              ? "Driver's food and accommodation"
              : null,
          ].filter(Boolean), // Remove null values
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
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    startDate: string;
    endDate: string;
    pickupTime: string;
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
        (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 3600 * 24) +
          1
      ) || 1;

    // Calculate fare
    //@ts-ignore
    const rates = ALL_INDIA_RATES[vehicleType];
    const baseFare = rates.baseFare * numberOfDays;
    const allowedDistance = 250 * numberOfDays;
    const extraDistance = Math.max(0, distance - allowedDistance);
    const extraDistanceFare = extraDistance * rates.extraKm;
    const totalFare = baseFare + extraDistanceFare;
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    // Create booking with PENDING status
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
        paymentMode: PaymentMode.RAZORPAY, // Force Razorpay for advance payment
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime,
        totalDays: numberOfDays,
        baseAmount: baseFare,
        totalAmount: totalFare,
        advanceAmount,
        remainingAmount,
        taxAmount: 0,
        status: "PENDING",
      },
    });

    // Create Razorpay order for advance payment
    const order = await razorpay.orders.create({
      amount: Math.round(advanceAmount * 100),
      currency: "INR",
      receipt: `ADV${booking.id.slice(-8)}`,
      notes: {
        bookingId: booking.id,
        userId: req.user.userId,
        type: "all_india_advance_payment",
      },
    });

    res.json({
      booking,
      paymentDetails: {
        order,
        amount: advanceAmount,
      },
      estimate: {
        distance,
        duration,
        totalFare,
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

    const availableBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "ADVANCE_PAID", // Only show bookings with paid advance
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: driverDetails.vehicleCategory ?? "",
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
            (new Date().getTime() - booking.createdAt.getTime()) / (1000 * 60)
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
    const result = await prisma.longDistanceBooking.updateMany({
      where: {
        id: bookingId,
        status: "ADVANCE_PAID", // Only update if status is ADVANCE_PAID
      },
      data: {
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
        driverAcceptedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status." });
    }

    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
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
      const updateResult = await prisma.longDistanceBooking.updateMany({
        where: {
          id: bookingId,
          userId: req.user!.userId,
          status: "PENDING", // Only update if status is PENDING
        },
        data: {
          status: "ADVANCE_PAID",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
          advancePaymentStatus: "COMPLETED",
        },
      });

      if (updateResult.count === 0) {
        throw new Error("Booking not found or invalid status for verification");
      }

      const booking = await prisma.longDistanceBooking.findUnique({
        where: { id: bookingId },
      });

      // Create transaction record
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: booking!.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: booking!.userId,
          receiverId: null,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for All India Tour ${bookingId}`,
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
    const updateResult = await prisma.longDistanceBooking.updateMany({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
      },
      data: {
        status: "DRIVER_PICKUP_STARTED",
      },
    });

    if (updateResult.count === 0) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status for pickup" });
    }

    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
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
    const updateResult = await prisma.longDistanceBooking.updateMany({
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

    if (updateResult.count === 0) {
      return res
        .status(404)
        .json({ error: "Booking not found or invalid status for arrival" });
    }

    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
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

    // Check if cancellation charge applies
    const shouldChargeCancellationFee =
      booking.status === "DRIVER_ACCEPTED" &&
      booking.driverAcceptedAt &&
      new Date().getTime() - booking.driverAcceptedAt.getTime() > 3 * 60 * 1000; // 3 minutes

    const CANCELLATION_FEE = 300;
    let updatedBooking;

    if (shouldChargeCancellationFee) {
      // Use transaction to handle cancellation fee
      updatedBooking = await prisma.$transaction(async (prisma) => {
        // Deduct from cancelling user's wallet
        const wallet = await prisma.wallet.findUnique({
          where: { userId: req.user!.userId },
        });

        if (!wallet || wallet.balance < CANCELLATION_FEE) {
          throw new Error("Insufficient wallet balance for cancellation fee");
        }

        // Update wallet
        await prisma.wallet.update({
          where: { userId: req.user!.userId },
          data: {
            balance: { decrement: CANCELLATION_FEE },
          },
        });

        // Create transaction record
        await prisma.longDistanceTransaction.create({
          data: {
            bookingId: bookingId,
            amount: CANCELLATION_FEE,
            type: "BOOKING_ADVANCE",
            status: "COMPLETED",
            senderId: req.user!.userId,
            receiverId: process.env.ADMIN_USER_ID!, // Send to admin wallet
            description: `Cancellation fee for booking ${bookingId}`,
            metadata: {
              cancellationType: "LATE_CANCELLATION",
              cancelledBy:
                req.user!.userId === booking.userId ? "USER" : "DRIVER",
            },
          },
        });

        // Update booking
        return await prisma.longDistanceBooking.update({
          where: { id: bookingId },
          data: {
            status: "CANCELLED",
            cancelReason: reason,
            metadata: {
              cancellationFee: CANCELLATION_FEE,
              cancelledBy:
                req.user!.userId === booking.userId ? "USER" : "DRIVER",
              cancellationTime: new Date(),
            },
          },
        });
      });
    } else {
      // Simple cancellation without fee
      updatedBooking = await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelReason: reason,
          metadata: {
            cancelledBy:
              req.user!.userId === booking.userId ? "USER" : "DRIVER",
            cancellationTime: new Date(),
          },
        },
      });
    }

    // Notify both parties through socket
    io.to(booking.userId).emit("booking_cancelled", {
      bookingId,
      reason,
      cancelledBy: req.user!.userId === booking.userId ? "USER" : "DRIVER",
      serviceType: "ALL_INDIA_TOUR",
      cancellationFee: shouldChargeCancellationFee ? CANCELLATION_FEE : 0,
    });

    if (booking.driverId) {
      io.to(booking.driverId).emit("booking_cancelled", {
        bookingId,
        reason,
        cancelledBy: req.user!.userId === booking.userId ? "USER" : "DRIVER",
        serviceType: "ALL_INDIA_TOUR",
        cancellationFee: shouldChargeCancellationFee ? CANCELLATION_FEE : 0,
      });
    }

    res.json({
      success: true,
      booking: updatedBooking,
      cancellationFee: shouldChargeCancellationFee ? CANCELLATION_FEE : 0,
    });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    if (
      error instanceof Error &&
      error.message === "Insufficient wallet balance for cancellation fee"
    ) {
      return res.status(400).json({
        error: "Insufficient wallet balance to cover cancellation fee",
        requiredAmount: 300,
      });
    }
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
      cancelReason: booking.cancelReason,

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
    const updateResult = await prisma.longDistanceBooking.updateMany({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "STARTED",
      },
      data: {
        status: "PAYMENT_PENDING",
      },
    });

    if (updateResult.count === 0) {
      return res.status(404).json({
        error: "Booking not found or invalid status for ride completion",
      });
    }

    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
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

    // Notify user through socket
    io.to(booking!.userId).emit("ride_completion_initiated", {
      bookingId,
      remainingAmount: booking!.remainingAmount,
      driverDetails: {
        name: booking!.driver?.name,
        phone: booking!.driver?.phone,
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

      // 3. Update driver's wallet - Fixed the null userId issue
      if (booking.driverId) {
        // Add null check
        await prisma.wallet.upsert({
          where: {
            userId: booking.driverId,
          },
          create: {
            userId: booking.driverId,
            balance: booking.remainingAmount,
          },
          update: {
            balance: {
              increment: booking.remainingAmount,
            },
          },
        });
      }

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
