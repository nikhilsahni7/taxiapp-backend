import type { Request, Response } from "express";
import { PrismaClient, PaymentMode } from "@prisma/client";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";
import { scheduleJob } from "node-schedule";

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

// Chardham Yatra rates based on vehicle type
const CHARDHAM_RATES = {
  mini: { perDayRate: 3200 },

  sedan: { perDayRate: 3500 },
  ertiga: { perDayRate: 4000 },
  innova: { perDayRate: 5600 },
  tempo_12: { perDayRate: 7500 },
  tempo_16: { perDayRate: 8000 },
  tempo_20: { perDayRate: 9000 },
  tempo_26: { perDayRate: 10000 },
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

// Helper function to determine if location is in Haridwar/Rishikesh area
const isHaridwarRishikeshArea = async (
  location: Location
): Promise<boolean> => {
  try {
    // Use distance calculator to check if location is within 30km of Haridwar or Rishikesh
    const haridwarDistance = await getCachedDistanceAndDuration(
      { lat: location.lat, lng: location.lng },
      { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
    );

    const rishikeshDistance = await getCachedDistanceAndDuration(
      { lat: location.lat, lng: location.lng },
      { lat: 30.0869, lng: 78.2676 } // Rishikesh coordinates
    );

    return haridwarDistance.distance <= 30 || rishikeshDistance.distance <= 30;
  } catch (error) {
    // Fallback to string matching if distance calculation fails
    const lowerLocation = location.address.toLowerCase();
    return (
      lowerLocation.includes("haridwar") || lowerLocation.includes("rishikesh")
    );
  }
};

// Helper function to determine if location is in Delhi area
const isDelhiArea = async (location: Location): Promise<boolean> => {
  try {
    // Use distance calculator to check if location is within 30km of Delhi
    const delhiDistance = await getCachedDistanceAndDuration(
      { lat: location.lat, lng: location.lng },
      { lat: 28.6139, lng: 77.209 } // Delhi coordinates
    );

    return delhiDistance.distance <= 30;
  } catch (error) {
    // Fallback to string matching if distance calculation fails
    const lowerLocation = location.address.toLowerCase();
    return (
      lowerLocation.includes("delhi") || lowerLocation.includes("new delhi")
    );
  }
};

// Schedule job to make bookings visible to drivers 2 hours before pickup time
const scheduleBookingVisibility = (bookingId: string, pickupDateTime: Date) => {
  const visibilityTime = new Date(pickupDateTime);
  visibilityTime.setHours(visibilityTime.getHours() - 2); // 2 hours before pickup

  // Only schedule if visibility time is in the future
  if (visibilityTime > new Date()) {
    scheduleJob(visibilityTime, async () => {
      try {
        await prisma.longDistanceBooking.update({
          where: { id: bookingId },
          data: {
            metadata: {
              isVisibleToDrivers: true,
            },
          },
        });
      } catch (error) {
        console.error(
          `Failed to update booking visibility for ${bookingId}:`,
          error
        );
      }
    });
  }
};

// Schedule job to expire booking if no driver accepts within 60 minutes
const scheduleBookingExpiry = (bookingId: string) => {
  const expiryTime = new Date();
  expiryTime.setMinutes(expiryTime.getMinutes() + 60); // 60 minutes from now

  scheduleJob(expiryTime, async () => {
    try {
      // Only expire if still in ADVANCE_PAID status and no driver assigned
      const result = await prisma.longDistanceBooking.updateMany({
        where: {
          id: bookingId,
          status: "ADVANCE_PAID",
          driverId: null,
        },
        data: {
          status: "CANCELLED",
          metadata: {
            cancelReason: "No driver accepted within time limit",
            cancelledBy: "SYSTEM",
            cancellationTime: new Date(),
          },
        },
      });
    } catch (error) {
      console.error(`Failed to expire booking ${bookingId}:`, error);
    }
  });
};

export const getChardhamFareEstimate = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
    numberOfDhams,
    extraDays = 0,
  } = req.body;

  try {
    // Validate input
    if (!pickupLocation || !vehicleType || !pickupTime || !numberOfDhams) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (numberOfDhams < 1 || numberOfDhams > 4) {
      return res
        .status(400)
        .json({ error: "Number of dhams must be between 1 and 4" });
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

    let numberOfDays: number;

    // Calculate number of days based on starting point and number of dhams
    if (startingPointType === "haridwar_rishikesh") {
      numberOfDays =
        CHARDHAM_DAYS.haridwar_rishikesh[numberOfDhams as 1 | 2 | 3 | 4] +
        extraDays;
    } else if (startingPointType === "delhi") {
      numberOfDays =
        CHARDHAM_DAYS.delhi[numberOfDhams as 1 | 2 | 3 | 4] + extraDays;
    } else {
      // For other locations, calculate based on distance
      // Default to Delhi schedule and add extra days based on distance
      numberOfDays =
        CHARDHAM_DAYS.delhi[numberOfDhams as 1 | 2 | 3 | 4] + extraDays;

      // Calculate distance to Delhi and add extra days if far
      try {
        const distanceToDelhi = await getCachedDistanceAndDuration(
          { lat: pickupLocation.lat, lng: pickupLocation.lng },
          { lat: 28.6139, lng: 77.209 } // Delhi coordinates
        );

        // Add 1 day for every 250km beyond 50km
        if (distanceToDelhi.distance > 50) {
          const extraDistanceDays = Math.ceil(
            (distanceToDelhi.distance - 50) / 250
          );
          numberOfDays += extraDistanceDays;
        }
      } catch (error) {
        console.error("Error calculating distance to Delhi:", error);
        // Keep default days if distance calculation fails
      }
    }

    // Parse dates for display
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = startDate ? new Date(startDate) : new Date(); // Use current date if not provided
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    let endDateTime;
    if (endDate) {
      endDateTime = new Date(endDate);
      endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    } else {
      // Calculate end date based on number of days
      endDateTime = new Date(startDateTime);
      endDateTime.setDate(endDateTime.getDate() + numberOfDays - 1);
    }

    // Calculate base fare
    const baseFare = rates.perDayRate * numberOfDays;

    // Calculate app commission (12%)
    const appCommission = baseFare * 0.12;

    // Calculate total fare
    const totalFare = baseFare;

    // Calculate advance amount (25%) and remaining amount (75%)
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    // Calculate driver payout (total - commission)
    const driverPayout = totalFare - appCommission;

    res.json({
      estimate: {
        baseFare,
        totalFare,
        advanceAmount,
        remainingAmount,
        appCommission,
        driverPayout,
        numberOfDays,
        perDayRate: rates.perDayRate,
        currency: "INR",
        vehicleType,
        vehicleCapacity: getVehicleCapacity(vehicleType),
        numberOfDhams,
        startingPointType,
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
    console.error("Error in Chardham fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

export const createChardhamBooking = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    vehicleType,
    startDate,
    endDate,
    pickupTime,
    numberOfDhams,
    extraDays = 0,
  }: {
    pickupLocation: Location;
    vehicleType: string;
    startDate?: string;
    endDate?: string;
    pickupTime: string;
    numberOfDhams: number;
    extraDays?: number;
  } = req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    // Validate input
    if (!pickupLocation || !vehicleType || !pickupTime || !numberOfDhams) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (numberOfDhams < 1 || numberOfDhams > 4) {
      return res
        .status(400)
        .json({ error: "Number of dhams must be between 1 and 4" });
    }

    // Get rates for vehicle type
    //@ts-ignore
    const rates = CHARDHAM_RATES[vehicleType];
    if (!rates) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    // Determine starting point type
    let startingPointType: "haridwar_rishikesh" | "delhi" | "other" = "other";

    if (await isHaridwarRishikeshArea(pickupLocation)) {
      startingPointType = "haridwar_rishikesh";
    } else if (await isDelhiArea(pickupLocation)) {
      startingPointType = "delhi";
    }

    let numberOfDays: number;

    // Calculate number of days based on starting point and number of dhams
    if (startingPointType === "haridwar_rishikesh") {
      numberOfDays =
        CHARDHAM_DAYS.haridwar_rishikesh[numberOfDhams as 1 | 2 | 3 | 4] +
        extraDays;
    } else if (startingPointType === "delhi") {
      numberOfDays =
        CHARDHAM_DAYS.delhi[numberOfDhams as 1 | 2 | 3 | 4] + extraDays;
    } else {
      // For other locations, calculate based on distance
      numberOfDays =
        CHARDHAM_DAYS.delhi[numberOfDhams as 1 | 2 | 3 | 4] + extraDays;

      try {
        const distanceToDelhi = await getCachedDistanceAndDuration(
          { lat: pickupLocation.lat, lng: pickupLocation.lng },
          { lat: 28.6139, lng: 77.209 } // Delhi coordinates
        );

        // Add 1 day for every 250km beyond 50km
        if (distanceToDelhi.distance > 50) {
          const extraDistanceDays = Math.ceil(
            (distanceToDelhi.distance - 50) / 250
          );
          numberOfDays += extraDistanceDays;
        }
      } catch (error) {
        console.error("Error calculating distance to Delhi:", error);
        // Keep default days if distance calculation fails
      }
    }

    // Parse dates
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = startDate ? new Date(startDate) : new Date(); // Use current date if not provided
    startDateTime.setHours(pickupHours, pickupMinutes, 0, 0);

    let endDateTime;
    if (endDate) {
      endDateTime = new Date(endDate);
      endDateTime.setHours(pickupHours, pickupMinutes, 0, 0);
    } else {
      // Calculate end date based on number of days
      endDateTime = new Date(startDateTime);
      endDateTime.setDate(endDateTime.getDate() + numberOfDays - 1);
    }

    // Calculate fare
    const baseFare = rates.perDayRate * numberOfDays;
    const appCommission = baseFare * 0.12;
    const totalFare = baseFare;
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;
    const driverPayout = totalFare - appCommission;

    // Determine if booking should be immediately visible to drivers
    const isImmediatePickup =
      startDateTime.getTime() - new Date().getTime() <= 2 * 60 * 60 * 1000; // 2 hours or less

    // Create booking with PENDING status
    const booking = await prisma.longDistanceBooking.create({
      data: {
        userId: req.user.userId,
        serviceType: "CHARDHAM_YATRA",
        pickupLocation: pickupLocation.address,
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        vehicleCategory: vehicleType,
        distance: 0, // Will be calculated later if needed
        duration: 0, // Will be calculated later if needed
        paymentMode: PaymentMode.RAZORPAY, // Force Razorpay for advance payment
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime,
        totalDays: numberOfDays,
        baseAmount: baseFare,
        totalAmount: totalFare,
        advanceAmount,
        remainingAmount,
        commission: appCommission,
        taxAmount: 0,
        status: "PENDING",
        metadata: {
          numberOfDhams,
          startingPointType,
          extraDays,
          perDayRate: rates.perDayRate,
          driverPayout,
          isVisibleToDrivers: isImmediatePickup,
          bookingExpiresAt: null, // Will be set after payment
        },
      },
    });

    // Create Razorpay order for advance payment
    const order = await razorpay.orders.create({
      amount: Math.round(advanceAmount * 100),
      currency: "INR",
      receipt: `CDY${booking.id.slice(-8)}`,
      notes: {
        bookingId: booking.id,
        userId: req.user.userId,
        type: "chardham_advance_payment",
      },
    });

    res.json({
      booking,
      paymentDetails: {
        order,
        amount: advanceAmount,
      },
      estimate: {
        totalFare,
        advanceAmount,
        remainingAmount,
        appCommission,
        driverPayout,
        numberOfDays,
        numberOfDhams,
      },
    });
  } catch (error) {
    console.error("Error creating Chardham booking:", error);
    res.status(500).json({ error: "Failed to create booking" });
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
      // Get booking details first
      const booking = await prisma.longDistanceBooking.findFirst({
        where: {
          id: bookingId,
          userId: req.user!.userId,
          status: "PENDING",
        },
      });

      if (!booking) {
        throw new Error("Booking not found or invalid status for verification");
      }

      // Calculate expiry time (60 minutes from now)
      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 60);

      // Update booking status
      const updatedBooking = await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "ADVANCE_PAID",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
          advancePaymentStatus: "COMPLETED",
          metadata: {
            ...(booking.metadata as any),
            bookingExpiresAt: expiryTime,
          },
        },
      });

      // Create transaction record
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: booking.advanceAmount,
          type: "BOOKING_ADVANCE",
          status: "COMPLETED",
          senderId: booking.userId,
          receiverId: null, // Will be assigned to driver later
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Advance payment for Chardham Yatra ${bookingId}`,
        },
      });

      return updatedBooking;
    });

    // Schedule booking expiry (60 minutes)
    scheduleBookingExpiry(bookingId);

    // Schedule booking visibility if it's a future booking
    const pickupDateTime = new Date(updatedBooking.startDate);
    pickupDateTime.setHours(
      ...updatedBooking.pickupTime.split(":").map(Number),
      0,
      0
    );
    scheduleBookingVisibility(bookingId, pickupDateTime);

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
};

export const getAvailableChardhamBookings = async (
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
        status: "ADVANCE_PAID", // Only show bookings with paid advance
        serviceType: "CHARDHAM_YATRA",
        vehicleCategory: driverDetails.vehicleCategory ?? "",
        driverId: null,
        metadata: {
          path: ["isVisibleToDrivers"],
          equals: true,
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

    const formattedBookings = availableBookings.map((booking) => {
      // Calculate expiry time
      const metadata = booking.metadata as any;
      const expiryTime = metadata?.bookingExpiresAt
        ? new Date(metadata.bookingExpiresAt)
        : new Date(booking.createdAt.getTime() + 60 * 60 * 1000); // 60 minutes from creation

      const expiresIn = Math.max(
        0,
        Math.floor((expiryTime.getTime() - now.getTime()) / (1000 * 60))
      );

      return {
        id: booking.id,
        pickupLocation: booking.pickupLocation,
        startDate: booking.startDate,
        endDate: booking.endDate,
        pickupTime: booking.pickupTime,
        totalDays: booking.totalDays,
        totalAmount: booking.totalAmount,
        advanceAmount: booking.advanceAmount,
        remainingAmount: booking.remainingAmount,
        commission: booking.commission,
        driverPayout: booking.totalAmount - booking.commission,
        paymentMode: booking.paymentMode,
        createdAt: booking.createdAt,
        metadata: booking.metadata,
        user: {
          name: booking.user.name,
          phone: booking.user.phone,
        },
        expiresIn,
      };
    });

    res.json({
      availableBookings: formattedBookings,
      count: formattedBookings.length,
    });
  } catch (error) {
    console.error("Error fetching available Chardham bookings:", error);
    res.status(500).json({ error: "Failed to fetch available bookings" });
  }
};

// Driver accepts booking
export const acceptChardhamBooking = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const result = await prisma.longDistanceBooking.updateMany({
      where: {
        id: bookingId,
        status: "ADVANCE_PAID", // Only update if status is ADVANCE_PAID
        driverId: null, // Ensure no driver has accepted yet
      },
      data: {
        driverId: req.user.userId,
        status: "DRIVER_ACCEPTED",
        driverAcceptedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res.status(404).json({
        error:
          "Booking not found, already accepted by another driver, or invalid status.",
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
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
              },
            },
          },
        },
      },
    });

    res.json({ booking });
  } catch (error) {
    console.error("Error accepting booking:", error);
    res.status(500).json({ error: "Failed to accept booking" });
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
    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const updateResult = await prisma.longDistanceBooking.updateMany({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_PICKUP_STARTED",
      },
      data: {
        status: "DRIVER_ARRIVED",
        driverArrivedAt: new Date(),
        otp,
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

// Start ride after OTP verification
export const startRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { otp } = req.body;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  if (!otp) {
    return res.status(400).json({ error: "OTP is required" });
  }

  try {
    // First verify the booking exists and has the correct OTP
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "DRIVER_ARRIVED",
        otp: otp, // Verify OTP matches
      },
      include: {
        user: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
    });

    if (!booking) {
      return res.status(400).json({ error: "Invalid booking ID or OTP" });
    }

    // Update booking status to STARTED
    const updatedBooking = await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        status: "STARTED",
        rideStartedAt: new Date(),
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
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
              },
            },
          },
        },
      },
    });

    res.json({
      success: true,
      message: "Ride started successfully",
      booking: updatedBooking,
    });
  } catch (error) {
    console.error("Error starting ride:", error);
    res.status(500).json({ error: "Failed to start ride" });
  }
};

// Get accepted bookings for a driver
export const getAcceptedBookings = async (req: Request, res: Response) => {
  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    const bookings = await prisma.longDistanceBooking.findMany({
      where: {
        driverId: req.user.userId,
        serviceType: "CHARDHAM_YATRA",
        status: {
          in: [
            "DRIVER_ACCEPTED",
            "DRIVER_PICKUP_STARTED",
            "DRIVER_ARRIVED",
            "STARTED",
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
        startDate: "asc",
      },
    });

    res.json({ bookings });
  } catch (error) {
    console.error("Error fetching accepted bookings:", error);
    res.status(500).json({ error: "Failed to fetch accepted bookings" });
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
            id: true,
            name: true,
            phone: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
                vehicleCategory: true,
              },
            },
          },
        },
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ booking });
  } catch (error) {
    console.error("Error fetching booking status:", error);
    res.status(500).json({ error: "Failed to fetch booking status" });
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

    const cancellationFee = 300; // Fixed cancellation fee

    // Use a transaction to update booking and handle cancellation fee if applicable.
    const updatedBooking = await prisma.$transaction(async (tx) => {
      // Update booking status to CANCELLED with the provided reason.
      const updated = await tx.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledBy: req.user!.userId === booking.userId ? "USER" : "DRIVER",
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
        // Create a transaction record for the cancellation fee.
        await tx.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: cancellationFee,
            type: "REFUND",
            status: "COMPLETED",
            senderId: req.user?.userId,
            receiverId:
              req.user?.userId === booking.userId
                ? booking.driverId
                : booking.userId,
            description: "Cancellation fee for Chardham Yatra booking",
          },
        });

        // Determine the receiving party and update (or create) their wallet.
        const receiverId =
          req.user?.userId === booking.userId
            ? booking.driverId
            : booking.userId;
        await tx.wallet.upsert({
          where: {
            userId: receiverId,
          },
          create: {
            userId: receiverId,
            balance: cancellationFee,
          },
          update: {
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

// Driver ends the ride
export const endRide = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { endOdometerReading } = req.body;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  try {
    // Verify the booking exists and is in STARTED status
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "STARTED",
      },
    });

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found or not in the correct status for ending",
      });
    }

    // Update booking status to PAYMENT_PENDING
    const updatedBooking = await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        status: "PAYMENT_PENDING",
        rideEndedAt: new Date(),
        metadata: {
          ...(booking.metadata as any),
          endOdometerReading,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    res.json({
      success: true,
      message: "Ride ended successfully, waiting for payment",
      booking: updatedBooking,
    });
  } catch (error) {
    console.error("Error ending ride:", error);
    res.status(500).json({ error: "Failed to end ride" });
  }
};

// User selects payment method
export const selectPaymentMethod = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { paymentMethod } = req.body;

  if (!req.user?.userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  if (!paymentMethod || !["CASH", "RAZORPAY"].includes(paymentMethod)) {
    return res
      .status(400)
      .json({ error: "Invalid payment method. Must be CASH or RAZORPAY" });
  }

  try {
    // Verify the booking exists and is in PAYMENT_PENDING status
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        userId: req.user.userId,
        status: "PAYMENT_PENDING",
      },
    });

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found or not in the correct status for payment",
      });
    }

    // Update the final payment mode
    await prisma.longDistanceBooking.update({
      where: { id: bookingId },
      data: {
        finalPaymentMode: paymentMethod as PaymentMode,
      },
    });

    if (paymentMethod === "RAZORPAY") {
      // Create Razorpay order for online payment
      const order = await razorpay.orders.create({
        amount: Math.round(booking.remainingAmount * 100),
        currency: "INR",
        receipt: `CDFP${booking.id.slice(-8)}`, // Chardham Final Payment
        notes: {
          bookingId: booking.id,
          userId: req.user.userId,
          type: "chardham_final_payment",
        },
      });

      return res.json({
        success: true,
        message: "Razorpay payment initiated",
        paymentDetails: {
          order,
          amount: booking.remainingAmount,
          key: process.env.RAZORPAY_KEY_ID,
        },
      });
    } else {
      // For CASH payment, update the booking metadata
      await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          metadata: {
            ...(booking.metadata as any),
            cashPaymentSelected: true,
            cashPaymentSelectedAt: new Date(),
          },
        },
      });

      return res.json({
        success: true,
        message: "Cash payment selected. Please pay the driver directly.",
        paymentDetails: {
          amount: booking.remainingAmount,
          paymentMethod: "CASH",
        },
      });
    }
  } catch (error) {
    console.error("Error selecting payment method:", error);
    res.status(500).json({ error: "Failed to select payment method" });
  }
};

// Verify Razorpay payment
export const verifyRazorpayPayment = async (req: Request, res: Response) => {
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

    const result = await prisma.$transaction(async (prisma) => {
      // Get booking details
      const booking = await prisma.longDistanceBooking.findFirst({
        where: {
          id: bookingId,
          userId: req.user!.userId,
          status: "PAYMENT_PENDING",
          finalPaymentMode: "RAZORPAY",
        },
        include: {
          driver: {
            select: {
              id: true,
            },
          },
        },
      });

      if (!booking) {
        throw new Error(
          "Booking not found or invalid status for payment verification"
        );
      }

      // Update booking status
      const updatedBooking = await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          status: "COMPLETED",
          finalPaymentId: razorpay_payment_id,
          finalPaymentStatus: "COMPLETED",
        },
      });

      // Create transaction record
      await prisma.longDistanceTransaction.create({
        data: {
          bookingId,
          amount: booking.remainingAmount,
          type: "BOOKING_FINAL",
          status: "COMPLETED",
          senderId: booking.userId,
          receiverId: booking.driverId,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: `Final payment for Chardham Yatra ${bookingId}`,
        },
      });

      // Update driver's wallet
      if (booking.driverId) {
        const driverPayout = booking.totalAmount - booking.commission;
        await prisma.wallet.upsert({
          where: { userId: booking.driverId },
          create: {
            userId: booking.driverId,
            balance: driverPayout,
          },
          update: {
            balance: {
              increment: driverPayout,
            },
          },
        });
      }

      return updatedBooking;
    });

    res.json({
      success: true,
      message: "Payment verified successfully",
      booking: result,
    });
  } catch (error) {
    console.error("Error verifying Razorpay payment:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
};

// Driver confirms cash collection
export const confirmCashCollection = async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { collected } = req.body;

  if (!req.user?.userId || req.user.userType !== "DRIVER") {
    return res.status(403).json({ error: "Unauthorized. Driver access only." });
  }

  if (collected === undefined) {
    return res
      .status(400)
      .json({ error: "Missing 'collected' field (true/false)" });
  }

  try {
    const booking = await prisma.longDistanceBooking.findFirst({
      where: {
        id: bookingId,
        driverId: req.user.userId,
        status: "PAYMENT_PENDING",
        finalPaymentMode: "CASH",
      },
    });

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found or not eligible for cash confirmation",
      });
    }

    if (collected) {
      // Cash collected successfully
      const result = await prisma.$transaction(async (prisma) => {
        // Update booking status
        const updatedBooking = await prisma.longDistanceBooking.update({
          where: { id: bookingId },
          data: {
            status: "COMPLETED",
            finalPaymentStatus: "COMPLETED",
          },
        });

        // Create transaction record
        await prisma.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: booking.remainingAmount,
            type: "BOOKING_FINAL",
            status: "COMPLETED",
            senderId: booking.userId,
            receiverId: booking.driverId,
            description: `Final cash payment for Chardham Yatra ${bookingId}`,
          },
        });

        // Update driver's wallet
        const driverPayout = booking.totalAmount - booking.commission;
        await prisma.wallet.upsert({
          where: { userId: booking.driverId! },
          create: {
            userId: booking.driverId!,
            balance: driverPayout,
          },
          update: {
            balance: {
              increment: driverPayout,
            },
          },
        });

        return updatedBooking;
      });

      res.json({
        success: true,
        message: "Cash payment confirmed and ride completed",
        booking: result,
      });
    } else {
      // Cash not collected
      await prisma.longDistanceBooking.update({
        where: { id: bookingId },
        data: {
          metadata: {
            ...(booking.metadata as any),
            cashPaymentFailed: true,
            cashPaymentFailedAt: new Date(),
          },
        },
      });

      res.json({
        success: false,
        message: "Cash payment not collected. User needs to try again.",
      });
    }
  } catch (error) {
    console.error("Error confirming cash collection:", error);
    res.status(500).json({ error: "Failed to confirm cash collection" });
  }
};

// Get payment status (for driver to check if user has selected payment method)
export const getPaymentStatus = async (req: Request, res: Response) => {
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
            id: true,
            name: true,
            phone: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Extract payment-related information
    const metadata = (booking.metadata as any) || {};

    res.json({
      bookingId: booking.id,
      status: booking.status,
      finalPaymentMode: booking.finalPaymentMode,
      finalPaymentStatus: booking.finalPaymentStatus,
      remainingAmount: booking.remainingAmount,
      cashPaymentSelected: metadata.cashPaymentSelected || false,
      cashPaymentSelectedAt: metadata.cashPaymentSelectedAt || null,
      cashPaymentFailed: metadata.cashPaymentFailed || false,
      user: booking.user,
      driver: booking.driver,
    });
  } catch (error) {
    console.error("Error getting payment status:", error);
    res.status(500).json({ error: "Failed to get payment status" });
  }
};
