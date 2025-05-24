import { PaymentMode, PrismaClient } from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import { scheduleJob } from "node-schedule";
import Razorpay from "razorpay";
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

// Chardham Yatra rates based on vehicle type
const CHARDHAM_RATES = {
  mini: { perDayRate: 3200, perKmRate: 11 },
  sedan: { perDayRate: 3500, perKmRate: 14 },
  ertiga: { perDayRate: 4000, perKmRate: 18 },
  innova: { perDayRate: 5600, perKmRate: 24 },
  tempo_12: { perDayRate: 7500, perKmRate: 23 },
  tempo_16: { perDayRate: 8000, perKmRate: 26 },
  tempo_20: { perDayRate: 9000, perKmRate: 30 },
  tempo_26: { perDayRate: 10000, perKmRate: 35 },
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
    selectedDhams = [],
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

    // Validate that the number of selected dhams matches numberOfDhams
    if (selectedDhams.length > 0 && selectedDhams.length !== numberOfDhams) {
      return res.status(400).json({
        error:
          "The number of selected dhams must match the numberOfDhams value",
      });
    }

    // Validate that selected dhams are valid
    const validDhams = ["Yamunotri", "Gangotri", "Kedarnath", "Badrinath"];
    if (selectedDhams.length > 0) {
      const invalidDhams = selectedDhams.filter(
        (dham: string) => !validDhams.includes(dham)
      );
      if (invalidDhams.length > 0) {
        return res.status(400).json({
          error: `Invalid dham name(s): ${invalidDhams.join(", ")}. Valid dhams are: ${validDhams.join(", ")}`,
        });
      }
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

    if (startingPointType === "other") {
      // Calculate distance to Haridwar for extra days and charges
      const distanceToHaridwar = await getCachedDistanceAndDuration(
        { lat: pickupLocation.lat, lng: pickupLocation.lng },
        { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
      );

      // Add extra days based on distance
      numberOfDays += calculateExtraDays(distanceToHaridwar.distance);

      // Calculate extra km charges
      extraKmCharges = calculateExtraKmCharges(
        distanceToHaridwar.distance,
        vehicleType
      );
    }

    // Add any user-requested extra days
    numberOfDays += extraDays;

    // Calculate base fare
    const baseFare = rates.perDayRate * numberOfDays;

    // Calculate total fare
    const totalFare = baseFare + extraKmCharges;

    // Calculate advance amount (25%) and remaining amount (75%)
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    // Calculate app commission (12%)
    const appCommission = totalFare * 0.12;

    // Calculate driver payout
    const driverPayout = totalFare - appCommission;

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
    let distanceToHaridwar = 0;
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
        totalFare,
        advanceAmount,
        remainingAmount,
        appCommission,
        driverPayout,
        numberOfDays,
        perDayRate: rates.perDayRate,
        perKmRate: rates.perKmRate,
        currency: "INR",
        vehicleType,
        vehicleCapacity: getVehicleCapacity(vehicleType),
        numberOfDhams,
        selectedDhams: selectedDhams.length > 0 ? selectedDhams : undefined,
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
    selectedDhams = [],
  }: {
    pickupLocation: Location;
    vehicleType: string;
    startDate?: string;
    endDate?: string;
    pickupTime: string;
    numberOfDhams: number;
    extraDays?: number;
    selectedDhams?: string[];
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

    // Validate that the number of selected dhams matches numberOfDhams
    if (selectedDhams.length > 0 && selectedDhams.length !== numberOfDhams) {
      return res.status(400).json({
        error:
          "The number of selected dhams must match the numberOfDhams value",
      });
    }

    // Validate that selected dhams are valid
    const validDhams = ["Yamunotri", "Gangotri", "Kedarnath", "Badrinath"];
    if (selectedDhams.length > 0) {
      const invalidDhams = selectedDhams.filter(
        (dham: string) => !validDhams.includes(dham)
      );
      if (invalidDhams.length > 0) {
        return res.status(400).json({
          error: `Invalid dham name(s): ${invalidDhams.join(", ")}. Valid dhams are: ${validDhams.join(", ")}`,
        });
      }
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

    // Calculate number of days based on starting point and number of dhams
    let numberOfDays =
      CHARDHAM_DAYS[startingPointType][numberOfDhams as 1 | 2 | 3 | 4] +
      extraDays;

    // Calculate extra kilometers charges
    let extraKmCharges = 0;

    // For other locations (not Delhi/Haridwar), calculate based on distance to Haridwar
    if (startingPointType === "other") {
      try {
        const distanceToHaridwar = await getCachedDistanceAndDuration(
          { lat: pickupLocation.lat, lng: pickupLocation.lng },
          { lat: 29.9457, lng: 78.1642 } // Haridwar coordinates
        );

        // Add extra days based on the new logic (2 days per 250km)
        numberOfDays += calculateExtraDays(distanceToHaridwar.distance);

        // Calculate extra charges for distance up to 200km
        extraKmCharges = calculateExtraKmCharges(
          distanceToHaridwar.distance,
          vehicleType
        );
      } catch (error) {
        console.error("Error calculating distance to Haridwar:", error);
        // Keep default days if distance calculation fails
      }
    }

    // Parse dates
    const [pickupHours, pickupMinutes] = pickupTime.split(":").map(Number);
    const startDateTime = startDate ? new Date(startDate) : new Date();
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

    // Calculate base fare and total fare
    const baseFare = rates.perDayRate * numberOfDays;
    const totalFare = baseFare + extraKmCharges;

    // Calculate advance amount (25%) and remaining amount (75%)
    const advanceAmount = totalFare * 0.25;
    const remainingAmount = totalFare * 0.75;

    // Calculate commission (12%)
    const commission = totalFare * 0.12;

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
        commission: commission,
        taxAmount: 0,
        status: "PENDING",
        selectedDhams: selectedDhams.length > 0 ? selectedDhams : [],
        metadata: {
          numberOfDhams,
          startingPointType,
          extraDays,
          perDayRate: rates.perDayRate,
          driverPayout: totalFare - commission,
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
        appCommission: commission,
        driverPayout: totalFare - commission,
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
      // Update booking status
      const updateResult = await prisma.longDistanceBooking.updateMany({
        where: {
          id: bookingId,
          userId: req.user!.userId,
          status: "PENDING",
        },
        data: {
          status: "ADVANCE_PAID",
          advancePaidAt: new Date(),
          advancePaymentId: razorpay_payment_id,
          advancePaymentStatus: "COMPLETED",
        },
      });

      if (updateResult.count === 0) {
        throw new Error("Booking not found or invalid status");
      }

      // Get updated booking details
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
          senderId: req.user!.userId,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: "Advance payment for Chardham Yatra booking",
        },
      });

      return booking;
    });

    // Schedule booking to be visible to drivers 2 hours before pickup
    const pickupDateTime = new Date(updatedBooking!.startDate);
    // Fix the spread operator issue by using individual values
    const timeComponents = updatedBooking!.pickupTime.split(":").map(Number);
    pickupDateTime.setHours(
      timeComponents[0] || 0,
      timeComponents[1] || 0,
      0,
      0
    );

    // Schedule booking visibility
    scheduleBookingVisibility(bookingId, pickupDateTime);

    // Schedule booking expiry if no driver accepts within 60 minutes
    scheduleBookingExpiry(bookingId);

    res.json({
      success: true,
      booking: updatedBooking,
      message: "Payment verified successfully",
    });
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

    // Check if user is authorized to cancel
    if (
      booking.userId !== req.user.userId &&
      booking.driverId !== req.user.userId
    ) {
      return res
        .status(403)
        .json({ error: "Unauthorized to cancel this booking" });
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

      if (isUserCancelling) {
        // USER CANCELLATION LOGIC
        const totalFare = booking.totalAmount;
        const advanceAmount = booking.advanceAmount; // 25% of total fare
        const cancellationFee = totalFare * USER_CANCELLATION_PERCENTAGE; // 10% of total fare
        const refundAmount = advanceAmount - cancellationFee; // 15% of total fare to be refunded

        // Update user's wallet with refund
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
            description: `Refund for Chardham Yatra booking cancellation (15% of advance payment)`,
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

        // If driver is assigned, compensate them
        if (booking.driverId) {
          await tx.wallet.upsert({
            where: { userId: booking.driverId },
            create: {
              userId: booking.driverId,
              balance: DRIVER_CANCELLATION_FEE,
            },
            update: { balance: { increment: DRIVER_CANCELLATION_FEE } },
          });

          // Create transaction record for driver compensation
          await tx.longDistanceTransaction.create({
            data: {
              bookingId,
              amount: DRIVER_CANCELLATION_FEE,
              type: "COMPENSATION",
              status: "COMPLETED",
              senderId: null,
              receiverId: booking.driverId,
              description: `Compensation for Chardham Yatra booking cancellation by user`,
              metadata: {
                transactionType: "CREDIT",
                compensationAmount: DRIVER_CANCELLATION_FEE,
                cancelledBy: "USER",
              },
            },
          });
        }

        return {
          ...updated,
          cancellationDetails: {
            totalFare,
            advanceAmount,
            cancellationFee,
            refundAmount,
            driverCompensation: booking.driverId ? DRIVER_CANCELLATION_FEE : 0,
          },
        };
      } else {
        // DRIVER CANCELLATION LOGIC
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
            description: `Penalty for Chardham Yatra booking cancellation by driver`,
            metadata: {
              transactionType: "DEBIT",
              penaltyAmount: DRIVER_CANCELLATION_FEE,
              cancelledBy: "DRIVER",
            },
          },
        });

        // Credit cancellation fee to user's wallet
        await tx.wallet.upsert({
          where: { userId: booking.userId },
          create: { userId: booking.userId, balance: DRIVER_CANCELLATION_FEE },
          update: { balance: { increment: DRIVER_CANCELLATION_FEE } },
        });

        // Create transaction record for user compensation
        await tx.longDistanceTransaction.create({
          data: {
            bookingId,
            amount: DRIVER_CANCELLATION_FEE,
            type: "COMPENSATION",
            status: "COMPLETED",
            senderId: null,
            receiverId: booking.userId,
            description: `Compensation for Chardham Yatra booking cancellation by driver`,
            metadata: {
              transactionType: "CREDIT",
              compensationAmount: DRIVER_CANCELLATION_FEE,
              cancelledBy: "DRIVER",
            },
          },
        });

        return {
          ...updated,
          cancellationDetails: {
            driverPenalty: DRIVER_CANCELLATION_FEE,
            userCompensation: DRIVER_CANCELLATION_FEE,
          },
        };
      }
    });

    res.json({
      success: true,
      booking: updatedBooking,
      message: `Booking cancelled successfully by ${req.user.userType.toLowerCase()}`,
    });
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

// Update isHaridwarRishikeshArea function to include more precise distance check
const isHaridwarRishikeshArea = async (
  location: Location
): Promise<boolean> => {
  try {
    // Use distance calculator to check if location is within 30km of Haridwar
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
