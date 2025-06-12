import {
  LongDistanceServiceType,
  OutstationTripType,
  PaymentMode,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { prisma } from "../lib/prisma";
import { io } from "../server";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";

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
// Import fare service
import { fareService } from "../services/fareService";

// Helper function to get outstation rates
async function getOutstationRate(
  vehicleType: string,
  rateType: "base" | "short" | "fixed" | "extra"
): Promise<number> {
  try {
    const serviceType = "OUTSTATION";
    let fareRateType: any;

    if (vehicleType.startsWith("tempo_")) {
      fareRateType = rateType === "fixed" ? "FIXED_RATE" : "EXTRA_KM";
    } else {
      fareRateType = rateType === "base" ? "BASE_RATE" : "SHORT_RATE";
    }

    return await fareService.getRate(serviceType, vehicleType, fareRateType);
  } catch (error) {
    console.error(
      "Error getting dynamic outstation rates, using fallback:",
      error
    );
    // Fallback rates
    const fallbackRates: Record<string, any> = {
      mini: { base: 11, short: 14 },
      sedan: { base: 13, short: 19 },
      ertiga: { base: 18, short: 24 },
      innova: { base: 21, short: 27 },
      tempo_12: { fixed: 16000, extra: 23 },
      tempo_16: { fixed: 18000, extra: 26 },
      tempo_20: { fixed: 20000, extra: 30 },
      tempo_26: { fixed: 22000, extra: 35 },
    };

    return fallbackRates[vehicleType]?.[rateType] || 0;
  }
}

// Helper function to get hill station rates
async function getHillStationRate(
  vehicleType: string,
  rateType: "base" | "fixed" | "extra"
): Promise<number> {
  try {
    const serviceType = "HILL_STATION";
    let fareRateType: any;

    if (vehicleType.startsWith("tempo_")) {
      fareRateType = rateType === "fixed" ? "FIXED_RATE" : "EXTRA_KM";
    } else {
      fareRateType = "BASE_RATE";
    }

    return await fareService.getRate(serviceType, vehicleType, fareRateType);
  } catch (error) {
    console.error(
      "Error getting dynamic hill station rates, using fallback:",
      error
    );
    // Fallback rates
    const fallbackRates: Record<string, any> = {
      mini: { base: 15 },
      sedan: { base: 17 },
      ertiga: { base: 22 },
      innova: { base: 28 },
      tempo_12: { fixed: 16000, extra: 23 },
      tempo_16: { fixed: 18000, extra: 26 },
      tempo_20: { fixed: 20000, extra: 30 },
      tempo_26: { fixed: 22000, extra: 35 },
    };

    return fallbackRates[vehicleType]?.[rateType] || 0;
  }
}

export const getOutstationFareEstimate = async (
  req: Request,
  res: Response
): Promise<void> => {
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
    if (serviceType === "HILL_STATION" && distance < 5) {
      res.status(400).json({
        error: "Hill station bookings require minimum 50km distance",
      });
      return;
    }

    let fare = await calculateOutstationFare(
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

async function calculateOutstationFare(
  distance: number,
  vehicleType: string,
  tripType: string,
  serviceType: LongDistanceServiceType = "OUTSTATION"
): Promise<number> {
  try {
    let fare = 0;

    if (vehicleType.startsWith("tempo_")) {
      // For tempo vehicles (round trip only)
      if (tripType === "ROUND_TRIP") {
        const fixedRate =
          serviceType === "HILL_STATION"
            ? await getHillStationRate(vehicleType, "fixed")
            : await getOutstationRate(vehicleType, "fixed");

        const extraRate =
          serviceType === "HILL_STATION"
            ? await getHillStationRate(vehicleType, "extra")
            : await getOutstationRate(vehicleType, "extra");

        fare = fixedRate;
        if (distance > 250) {
          const extraKm = distance - 250;
          fare += extraKm * extraRate;
        }
      }
    } else {
      // For cars
      if (serviceType === "HILL_STATION") {
        const baseRate = await getHillStationRate(vehicleType, "base");
        fare = distance * baseRate;
      } else {
        const baseRate = await getOutstationRate(vehicleType, "base");
        const shortRate = await getOutstationRate(vehicleType, "short");
        const ratePerKm = distance <= 150 ? shortRate : baseRate;
        fare = distance * ratePerKm;
      }

      if (tripType === "ROUND_TRIP") {
        fare *= 2;
      }
    }

    return Math.round(fare);
  } catch (error) {
    console.error("Error calculating outstation fare:", error);
    throw new Error("Failed to calculate fare");
  }
}

export const searchOutstationDrivers = async (
  req: Request,
  res: Response
): Promise<void> => {
  const {
    pickupLocation,
    dropLocation,
    vehicleType,
    tripType,
    startDate,
    endDate,
    pickupTime,
    serviceType = "OUTSTATION",
  }: {
    pickupLocation: Location;
    dropLocation: Location;
    vehicleType: string;
    tripType: string;
    startDate: string;
    endDate: string;
    pickupTime: string;
    serviceType?: LongDistanceServiceType;
    paymentMode: PaymentMode;
  } = req.body;

  if (!req.user?.userId) {
    res.status(401).json({ error: "User not authenticated" });
    return;
  }

  try {
    const { distance, duration } = await getCachedDistanceAndDuration(
      { lat: pickupLocation.lat, lng: pickupLocation.lng },
      { lat: dropLocation.lat, lng: dropLocation.lng }
    );

    const fare = await calculateOutstationFare(
      distance,
      vehicleType,
      tripType,
      serviceType
    );

    // Calculate platform commission (12% of total fare)
    const commission = Math.round(fare * 0.12);
    const driverEarnings = fare - commission;

    // Parse dates and calculate total days
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = new Date(startDate);
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    const endDateTime =
      tripType === "ROUND_TRIP" && endDate
        ? new Date(endDate)
        : new Date(startDate);

    if (tripType === "ROUND_TRIP" && endDate) {
      endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    }

    const totalDays =
      tripType === "ROUND_TRIP" && endDate
        ? Math.ceil(
            (endDateTime.getTime() - startDateTime.getTime()) /
              (1000 * 3600 * 24) +
              1
          ) || 1
        : 1;

    const booking = await prisma.longDistanceBooking.create({
      data: {
        userId: req.user.userId,
        serviceType,
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
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime: pickupTime,
        totalDays: totalDays,
        baseAmount: fare,
        taxAmount: 0,
        totalAmount: fare,
        advanceAmount: commission, // 12% as advance
        remainingAmount: fare - commission, // 88% remaining
        commission: commission, // Store the commission amount
        status: "PENDING",
      },
    });

    // Create Razorpay order for advance payment (12%)
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
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime,
        totalDays,
      },
    });
  } catch (error) {
    console.error("Error creating booking:", error);
    res.status(500).json({ error: "Failed to create booking" });
  }
};

// Verify advance payment and make booking available to drivers
export const verifyAdvancePayment = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!req.user?.userId) {
    res.status(401).json({ error: "User not authenticated" });
    return;
  }

  try {
    // Verify payment signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
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
export const acceptOutstationBooking = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
  }

  try {
    // Check if driver has paid registration fee
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driverDetails || !driverDetails.registrationFeePaid) {
      res.status(403).json({
        error:
          "Registration fee not paid. Please pay the registration fee to accept bookings.",
      });
      return;
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

// Driver starts journey to pickup location
export const startDriverPickup = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
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
export const driverArrived = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
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
export const startRide = async (req: Request, res: Response): Promise<void> => {
  const { bookingId } = req.params;
  const { otp } = req.body;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
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
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    if (booking.otp !== otp) {
      res.status(400).json({ error: "Invalid OTP" });
      return;
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
export const cancelBooking = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  const { reason } = req.body;

  if (!req.user?.userId || !req.user?.userType) {
    res.status(401).json({ error: "User not authenticated" });
    return;
  }

  try {
    const booking = await prisma.longDistanceBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    // Check if user is authorized to cancel
    if (
      booking.userId !== req.user.userId &&
      booking.driverId !== req.user.userId
    ) {
      res.status(403).json({ error: "Unauthorized to cancel this booking" });
      return;
    }

    const DRIVER_CANCELLATION_FEE = 500; // Fixed fee when driver cancels
    const USER_CANCELLATION_PERCENTAGE = 0.1; // 10% of total fare

    // Use a transaction to update booking and handle cancellation fees
    const updatedBooking = await prisma.$transaction(async (tx) => {
      // Update booking status to CANCELLED
      const updated = await tx.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelReason: reason,
          cancelledBy: req.user!.userType === "USER" ? "USER" : "DRIVER",
          cancelledAt: new Date(),
        },
      });

      const isUserCancelling = req.user!.userType === "USER";
      const isDriverArrived =
        booking.status === "DRIVER_ARRIVED" ||
        booking.status === "STARTED" ||
        booking.status === "PAYMENT_PENDING";

      if (isUserCancelling) {
        if (isDriverArrived) {
          // USER CANCELLATION AFTER DRIVER ARRIVED
          const totalFare = booking.totalAmount;
          const advanceAmount = booking.advanceAmount; // 12% of total fare
          const cancellationFee = totalFare * USER_CANCELLATION_PERCENTAGE; // 10% of total fare
          const refundAmount = advanceAmount - cancellationFee; // 2% refund

          // Update user's wallet with refund (2%)
          await tx.wallet.upsert({
            where: { userId: booking.userId },
            create: { userId: booking.userId, balance: refundAmount },
            update: { balance: { increment: refundAmount } },
          });

          // Create transaction record for user refund
          await tx.longDistanceTransaction.create({
            data: {
              bookingId,
              amount: refundAmount,
              type: "REFUND",
              status: "COMPLETED",
              senderId: null,
              receiverId: booking.userId,
              description: `Refund for booking cancellation (2% of advance payment)`,
              metadata: {
                transactionType: "CREDIT",
                totalFare,
                advanceAmount,
                cancellationFee,
                refundAmount,
                cancelledBy: "USER",
              },
            },
          });
        } else {
          // USER CANCELLATION BEFORE DRIVER ARRIVED - FULL REFUND
          // Update user's wallet with full refund
          await tx.wallet.upsert({
            where: { userId: booking.userId },
            create: { userId: booking.userId, balance: booking.advanceAmount },
            update: { balance: { increment: booking.advanceAmount } },
          });

          // Create transaction record for full refund
          await tx.longDistanceTransaction.create({
            data: {
              bookingId,
              amount: booking.advanceAmount,
              type: "REFUND",
              status: "COMPLETED",
              senderId: null,
              receiverId: booking.userId,
              description: `Full refund for booking cancellation before driver arrival`,
              metadata: {
                transactionType: "CREDIT",
                totalFare: booking.totalAmount,
                refundAmount: booking.advanceAmount,
                cancelledBy: "USER",
              },
            },
          });
        }
      } else {
        // DRIVER CANCELLATION
        if (isDriverArrived) {
          // DRIVER CANCELLATION AFTER ARRIVAL
          // Deduct cancellation fee from driver's wallet
          await tx.wallet.upsert({
            where: { userId: booking.driverId! },
            create: {
              userId: booking.driverId!,
              balance: -DRIVER_CANCELLATION_FEE,
            },
            update: { balance: { decrement: DRIVER_CANCELLATION_FEE } },
          });

          // Create transaction record for driver penalty
          await tx.longDistanceTransaction.create({
            data: {
              bookingId,
              amount: DRIVER_CANCELLATION_FEE,
              type: "PENALTY",
              status: "COMPLETED",
              senderId: booking.driverId!,
              receiverId: null,
              description: `Penalty for booking cancellation by driver after arrival`,
              metadata: {
                transactionType: "DEBIT",
                penaltyAmount: DRIVER_CANCELLATION_FEE,
                cancelledBy: "DRIVER",
              },
            },
          });
        }

        // Refund full advance to user for driver cancellation
        await tx.wallet.upsert({
          where: { userId: booking.userId },
          create: { userId: booking.userId, balance: booking.advanceAmount },
          update: { balance: { increment: booking.advanceAmount } },
        });

        // Create transaction record for user refund
        await tx.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: booking.advanceAmount,
            type: "REFUND",
            status: "COMPLETED",
            senderId: null,
            receiverId: booking.userId,
            description: `Full refund for booking cancellation by driver`,
            metadata: {
              transactionType: "CREDIT",
              refundAmount: booking.advanceAmount,
              cancelledBy: "DRIVER",
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
export const getAvailableBookings = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
  }

  try {
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driverDetails) {
      res.status(404).json({ error: "Driver details not found" });
      return;
    }

    // Fetch all advance paid bookings not yet accepted by a driver
    const allAdvancePaidBookings = await prisma.longDistanceBooking.findMany({
      where: {
        status: "ADVANCE_PAID", // Only show paid bookings
        driverId: null, // Not yet accepted by any driver
        // Vehicle category filter will be applied in code
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

    const driverVehicleCategory = driverDetails.vehicleCategory?.toLowerCase();
    let filteredBookings = allAdvancePaidBookings;

    if (driverVehicleCategory) {
      const categoryHierarchy: Record<string, string[]> = {
        // Cars: Driver category can accept bookings for these categories
        mini: ["mini"],
        sedan: ["mini", "sedan"],
        ertiga: ["mini", "sedan", "ertiga"],
        innova: ["mini", "sedan", "ertiga", "innova"],
        // Tempos: Driver category can accept bookings for these categories
        tempo_12: ["tempo_12"],
        tempo_16: ["tempo_12", "tempo_16"],
        tempo_20: ["tempo_12", "tempo_16", "tempo_20"],
        tempo_26: ["tempo_12", "tempo_16", "tempo_20", "tempo_26"],
      };

      const allowedBookingCategories =
        categoryHierarchy[driverVehicleCategory] || [];

      filteredBookings = allAdvancePaidBookings.filter((booking) => {
        const bookingCategory = booking.vehicleCategory?.toLowerCase();
        return (
          bookingCategory && allowedBookingCategories.includes(bookingCategory)
        );
      });
    } else {
      // If driver has no vehicle category, they see no category-specific bookings
      filteredBookings = [];
    }

    // Format response
    const formattedBookings = filteredBookings.map((booking) => ({
      id: booking.id,
      serviceType: booking.serviceType,
      tripType: booking.tripType,
      pickupLocation: booking.pickupLocation,
      dhams: booking.selectedDhams ?? [],

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

export const getBookingStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  if (!req.user?.userId) {
    res.status(401).json({ error: "User not authenticated" });
    return;
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
      res.status(404).json({ error: "Booking not found" });
      return;
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
export const initiateRideCompletion = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
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
      res.status(404).json({ error: "Booking not found or invalid status" });
      return;
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
export const confirmRideCompletion = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;
  const {
    paymentMode,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
  } = req.body;

  if (!req.user?.userId) {
    res.status(401).json({ error: "User not authenticated" });
    return;
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
      res.status(404).json({ error: "Booking not found or invalid status" });
      return;
    }

    // Handle Razorpay payment
    if (paymentMode === "RAZORPAY") {
      // Verify the payment signature
      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        res.status(400).json({ error: "Missing payment details" });
        return;
      }

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_SECRET!)
        .update(body.toString())
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        res.status(400).json({ error: "Invalid payment signature" });
        return;
      }

      // Verify payment amount with Razorpay
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.amount !== Math.round(booking.remainingAmount * 100)) {
        res.status(400).json({ error: "Payment amount mismatch" });
        return;
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

      if (paymentMode === "RAZORPAY") {
        // 2. Create transaction record for online payment
        await prisma.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: booking.remainingAmount,
            type: "BOOKING_FINAL",
            status: "COMPLETED",
            senderId: booking.userId,
            receiverId: booking.driverId!,
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            description: `Final payment for ${booking.serviceType.toLowerCase()} ride ${bookingId}`,
            metadata: {
              paymentType: "RAZORPAY",
              orderId: razorpay_order_id,
              paymentId: razorpay_payment_id,
            },
          },
        });

        // 3. Update driver's wallet with remaining amount (88%) only for online payments
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
      } else {
        // For cash payments, just create a transaction record
        await prisma.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: booking.remainingAmount,
            type: "BOOKING_FINAL",
            status: "COMPLETED",
            senderId: booking.userId,
            receiverId: booking.driverId!,
            description: `Final cash payment for ${booking.serviceType.toLowerCase()} ride ${bookingId}`,
            metadata: {
              paymentType: "CASH",
              collectedBy: "DRIVER",
            },
          },
        });
      }

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

// Create Razorpay order for final payment
export const createFinalPaymentOrder = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { bookingId } = req.params;

  if (!req.user?.userId) {
    res.status(401).json({ error: "User not authenticated" });
    return;
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
      res.status(404).json({ error: "Booking not found or invalid status" });
      return;
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
export const getAcceptedBookings = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    res.status(403).json({ error: "Unauthorized. Driver access only." });
    return;
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
