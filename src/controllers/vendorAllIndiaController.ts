import { LongDistanceServiceType, PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { getCachedDistanceAndDuration } from "../utils/distanceCalculator";

const prisma = new PrismaClient();

// Define the rates with proper type - Copied from vendorController.ts for consistency
// Consider moving this to a shared constants file later
const VENDOR_RATES: Record<LongDistanceServiceType, Record<string, any>> = {
  OUTSTATION: {
    mini: { base: 13, short: 17 },
    sedan: { base: 15, short: 20 },
    ertiga: { base: 18, short: 23 },
    innova: { base: 21, short: 27 },
    tempo_12: { fixed: 17000, extra: 26 },
    tempo_16: { fixed: 19000, extra: 29 },
    tempo_20: { fixed: 21000, extra: 33 },
    tempo_26: { fixed: 23000, extra: 38 },
  },
  HILL_STATION: {
    mini: { base: 18 },
    sedan: { base: 23 },
    ertiga: { base: 27 },
    innova: { base: 30 },
    tempo_12: { fixed: 17000, extra: 26 },
    tempo_16: { fixed: 19000, extra: 29 },
    tempo_20: { fixed: 21000, extra: 33 },
    tempo_26: { fixed: 23000, extra: 38 },
  },
  ALL_INDIA_TOUR: {
    mini: { perDay: 2750, extraKm: 14 }, // Using rates consistent with allIndiaController initially, adjust if needed
    sedan: { perDay: 3500, extraKm: 16 },
    ertiga: { perDay: 4500, extraKm: 16 },
    innova: { perDay: 6000, extraKm: 18 },
    tempo_12: { perDay: 7000, extraKm: 20 },
    tempo_16: { perDay: 8000, extraKm: 22 },
    tempo_20: { perDay: 9000, extraKm: 24 },
    tempo_26: { perDay: 10000, extraKm: 26 },
  },
  // Ensure CHARDHAM_YATRA exists if needed by type, even if empty
  CHARDHAM_YATRA: {},
};

// Helper function to get vehicle capacity - Copied from allIndiaController.ts
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

// Helper function to calculate All India Tour app base price
function calculateAllIndiaAppBasePrice(
  distance: number, // One-way distance
  numberOfDays: number,
  vehicleType: string
): {
  appBasePrice: number;
  roundTripDistance: number;
  allowedDistance: number;
  extraDistance: number;
  baseFareComponent: number;
  extraDistanceFareComponent: number;
  rates: { perDay: number; extraKm: number };
} {
  const rates = VENDOR_RATES.ALL_INDIA_TOUR[vehicleType];
  if (!rates) {
    throw new Error(`Invalid vehicle type for ALL_INDIA_TOUR: ${vehicleType}`);
  }

  // Calculate round trip distance
  const roundTripDistance = distance * 2;

  // Calculate allowed distance based on number of days
  const allowedDistance = 250 * numberOfDays;

  // Calculate base fare
  const baseFareComponent = rates.perDay * numberOfDays;

  // Calculate extra distance fare if applicable
  const extraDistance = Math.max(0, roundTripDistance - allowedDistance);
  const extraDistanceFareComponent = extraDistance * rates.extraKm;

  // Calculate total app base price
  const appBasePrice = baseFareComponent + extraDistanceFareComponent;

  return {
    appBasePrice: Math.round(appBasePrice),
    roundTripDistance: Math.round(roundTripDistance),
    allowedDistance,
    extraDistance: Math.round(extraDistance),
    baseFareComponent: Math.round(baseFareComponent),
    extraDistanceFareComponent: Math.round(extraDistanceFareComponent),
    rates,
  };
}

/**
 * Get fare estimate for a vendor-initiated All India Tour booking.
 * All India Tours are always round trips.
 */
export const getVendorAllIndiaFareEstimate = async (
  req: Request,
  res: Response
) => {
  const {
    pickupLocation, // { lat, lng, address }
    dropLocation, // { lat, lng, address }
    vehicleType,
    startDate,
    endDate,
    pickupTime,
    vendorPrice,
  } = req.body;

  // Basic validation
  if (
    !pickupLocation ||
    !dropLocation ||
    !vehicleType ||
    !startDate ||
    !endDate ||
    !pickupTime ||
    vendorPrice === undefined
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Get one-way distance
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

    // Calculate number of days (inclusive)
    const numberOfDays =
      Math.ceil(
        (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 3600 * 24)
      ) + 1 || 1; // Add 1 because both start and end dates are inclusive

    // Calculate app base price and other distance details
    const {
      appBasePrice,
      roundTripDistance,
      allowedDistance,
      extraDistance,
      baseFareComponent,
      extraDistanceFareComponent,
      rates,
    } = calculateAllIndiaAppBasePrice(distance, numberOfDays, vehicleType);

    // Validate vendor price
    if (vendorPrice < appBasePrice) {
      return res.status(400).json({
        error: `Vendor price (₹${vendorPrice}) cannot be less than the app base price (₹${appBasePrice})`,
      });
    }

    // Calculate commissions and payouts
    const appCommissionFromBase = Math.round(appBasePrice * 0.12); // 12% commission on app base
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1); // 10% of vendor markup
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = appBasePrice - appCommissionFromBase; // Driver gets base price minus app's cut from base
    const vendorPayout = vendorCommission - appCommissionFromVendor; // Vendor gets their markup minus app's cut from markup

    res.json({
      estimate: {
        // Pricing
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        // Fare Breakdown
        fareBreakdown: {
          baseFareComponent, // Based on days
          extraDistanceFareComponent, // Based on extra KMs
        },
        // Commission Breakdown
        commissionBreakdown: {
          appCommissionFromBase,
          appCommissionFromVendor,
          // Note: driverCommission from vendorController perspective is the appCommissionFromBase
          driverCommission: appCommissionFromBase,
        },
        // Trip Details
        tripDetails: {
          type: "ROUND_TRIP", // Always round trip for All India Tour
          distance: roundTripDistance, // Show round trip distance
          oneWayDistance: distance,
          numberOfDays,
          allowedDistance,
          extraDistance,
          startDateTime: startDateTime.toISOString(),
          endDateTime: endDateTime.toISOString(),
          pickupTime,
        },
        // Vehicle Details
        vehicleType,
        vehicleCapacity: getVehicleCapacity(vehicleType),
        // Rates Used
        rates: {
          perDayRate: rates.perDay,
          extraKmRate: rates.extraKm,
          perDayKmLimit: 250,
        },
        currency: "INR",
      },
    });
  } catch (error: any) {
    console.error("Error calculating All India Tour fare estimate:", error);
    res
      .status(500)
      .json({ error: `Failed to calculate fare estimate: ${error.message}` });
  }
};

/**
 * Create a vendor-initiated All India Tour booking.
 */
export const createVendorAllIndiaBooking = async (
  req: Request,
  res: Response
) => {
  if (!req.user?.userId || req.user.userType !== "VENDOR") {
    return res.status(403).json({ error: "Unauthorized. Vendor access only." });
  }

  const {
    pickupLocation, // { lat, lng, address }
    dropLocation, // { lat, lng, address }
    vehicleType, // Renamed from vehicleCategory for consistency
    startDate,
    endDate,
    pickupTime,
    vendorPrice,
    notes,
  } = req.body;

  // Basic validation
  if (
    !pickupLocation ||
    !pickupLocation.lat ||
    !pickupLocation.lng ||
    !pickupLocation.address ||
    !dropLocation ||
    !dropLocation.lat ||
    !dropLocation.lng ||
    !dropLocation.address ||
    !vehicleType ||
    !startDate ||
    !endDate ||
    !pickupTime ||
    vendorPrice === undefined
  ) {
    return res.status(400).json({
      error:
        "Missing required fields (pickupLocation, dropLocation, vehicleType, startDate, endDate, pickupTime, vendorPrice)",
    });
  }

  try {
    // Get one-way distance
    const { distance: oneWayDistance } = await getCachedDistanceAndDuration(
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
      ) + 1 || 1;

    // Calculate app base price and other distance details
    const {
      appBasePrice,
      roundTripDistance,
      allowedDistance,
      extraDistance,
      rates,
    } = calculateAllIndiaAppBasePrice(
      oneWayDistance,
      numberOfDays,
      vehicleType
    );

    // Validate vendor price
    if (vendorPrice < appBasePrice) {
      return res.status(400).json({
        error: `Vendor price (₹${vendorPrice}) cannot be less than the app base price (₹${appBasePrice})`,
      });
    }

    // Calculate commissions and payouts
    const appCommissionFromBase = Math.round(appBasePrice * 0.12);
    const vendorCommission = vendorPrice - appBasePrice;
    const appCommissionFromVendor = Math.round(vendorCommission * 0.1);
    const totalAppCommission = appCommissionFromBase + appCommissionFromVendor;
    const driverPayout = appBasePrice - appCommissionFromBase;
    const vendorPayout = vendorCommission - appCommissionFromVendor;

    // Create booking
    const booking = await prisma.vendorBooking.create({
      data: {
        vendor: {
          connect: { id: req.user.userId },
        },
        serviceType: "ALL_INDIA_TOUR",
        tripType: "ROUND_TRIP", // Always Round Trip
        pickupLocation: pickupLocation.address,
        dropLocation: dropLocation.address,
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        dropLat: dropLocation.lat,
        dropLng: dropLocation.lng,
        vehicleCategory: vehicleType, // Mapped to vehicleCategory in schema
        distance: roundTripDistance, // Store round trip distance
        duration: numberOfDays * 24 * 60, // Duration in minutes
        startDate: startDateTime,
        endDate: endDateTime,
        pickupTime,
        totalDays: numberOfDays,
        appBasePrice,
        vendorPrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        status: "PENDING", // Initial status
        notes,
        metadata: {
          oneWayDistance,
          allowedDistance,
          extraDistance,
          perDayRate: rates.perDay,
          extraKmRate: rates.extraKm,
          perDayKmLimit: 250,
          vehicleCapacity: getVehicleCapacity(vehicleType),
        },
      },
    });

    res.status(201).json({
      booking,
      breakdown: {
        totalAmount: vendorPrice,
        appBasePrice,
        vendorCommission,
        appCommission: totalAppCommission,
        driverPayout,
        vendorPayout,
        numberOfDays,
        distance: roundTripDistance,
      },
    });
  } catch (error: any) {
    console.error("Error creating vendor All India Tour booking:", error);
    res
      .status(500)
      .json({ error: `Failed to create booking: ${error.message}` });
  }
};
