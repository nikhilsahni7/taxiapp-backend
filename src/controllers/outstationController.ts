import type { Request, Response } from "express";
import {
  PrismaClient,
  RideType,
  OutstationTripType,
  RideStatus,
} from "@prisma/client";
import {
  calculateDistance,
  calculateDuration,
  generateOTP,
} from "./rideController";
import { io } from "../server";

const prisma = new PrismaClient();

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

// Add this constant
const OUTSTATION_REQUEST_EXPIRY = 60 * 60 * 1000; // 1 hour in milliseconds

export const getOutstationFareEstimate = async (
  req: Request,
  res: Response
) => {
  const { pickupLocation, dropLocation, tripType, vehicleType } = req.body;

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);

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

export const broadcastOutstationRide = async (ride: any) => {
  try {
    // Get all online drivers
    const onlineDrivers = await prisma.driverStatus.findMany({
      where: {
        isOnline: true,
        socketId: { not: null },
      },
      include: {
        driver: {
          include: {
            driverDetails: true,
          },
        },
      },
    });

    // Filter drivers by vehicle category if needed
    const eligibleDrivers = onlineDrivers.filter(
      (driver) =>
        driver.driver.driverDetails?.vehicleCategory === ride.carCategory
    );

    // Broadcast to all eligible drivers
    for (const driver of eligibleDrivers) {
      io.to(driver.socketId!).emit("outstation_ride_request", {
        rideId: ride.id,
        pickupLocation: ride.pickupLocation,
        dropLocation: ride.dropLocation,
        fare: ride.fare,
        distance: ride.distance,
        duration: ride.duration,
        tripType: ride.outstationType,
        paymentMode: ride.paymentMode,
        userId: ride.userId,
        userName: ride.user.name,
        userPhone: ride.user.phone,
      });
    }

    return {
      success: true,
      message: `Ride broadcast to ${eligibleDrivers.length} drivers`,
      notifiedDrivers: eligibleDrivers.length,
    };
  } catch (error) {
    console.error("Error broadcasting outstation ride:", error);
    return {
      success: false,
      message: "Failed to broadcast ride",
      error,
    };
  }
};

export const createOutstationRide = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation, vehicleType, tripType, paymentMode } =
    req.body;

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const userId = req.user.userId;

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);
    const fare = calculateOutstationFare(distance, vehicleType, tripType);

    // Add requestExpiresAt field to track request expiry
    const ride = await prisma.ride.create({
      data: {
        userId,
        pickupLocation,
        dropLocation,
        carCategory: vehicleType,
        fare,
        distance,
        duration,
        status: RideStatus.SEARCHING,
        paymentMode,
        rideType: RideType.OUTSTATION,
        outstationType:
          tripType === "ONE_WAY"
            ? OutstationTripType.ONE_WAY
            : OutstationTripType.ROUND_TRIP,
        otp: generateOTP().toString(),
        requestExpiresAt: new Date(Date.now() + OUTSTATION_REQUEST_EXPIRY), // Add expiry time
      },
      include: {
        user: {
          select: { name: true, phone: true },
        },
      },
    });

    // Schedule automatic cancellation if no driver accepts
    setTimeout(async () => {
      const currentRide = await prisma.ride.findUnique({
        where: { id: ride.id },
      });

      if (currentRide && currentRide.status === RideStatus.SEARCHING) {
        await prisma.ride.update({
          where: { id: ride.id },
          data: {
            status: RideStatus.CANCELLED,
          },
        });

        // Notify user about cancellation
        io.to(ride.userId).emit("outstation_ride_expired", {
          rideId: ride.id,
          message: "No driver accepted your ride request",
        });
      }
    }, OUTSTATION_REQUEST_EXPIRY);

    // Broadcast to drivers
    const broadcastResult = await broadcastOutstationRide(ride);

    res.status(201).json({
      success: true,
      message: "Outstation ride created and broadcast to drivers",
      ride,
      broadcastResult,
      requestExpiresAt: ride.requestExpiresAt,
    });
  } catch (error) {
    console.error("Error creating outstation ride:", error);
    res.status(500).json({ error: "Failed to create outstation ride" });
  }
};

// Add this function to check if ride request is still valid
export const isRideRequestValid = async (rideId: string): Promise<boolean> => {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
  });

  if (!ride) return false;

  return (
    ride.status === RideStatus.SEARCHING &&
    new Date() < new Date(ride.requestExpiresAt!)
  );
};

// Update the socket handler for driver acceptance

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

  return fare;
}
