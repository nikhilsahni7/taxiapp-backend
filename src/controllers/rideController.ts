import type { Request, Response } from "express";
import { PrismaClient, RideStatus } from "@prisma/client";

import { searchAvailableDrivers } from "../lib/driverService";

import { io } from "../server";
import axios from "axios";

const prisma = new PrismaClient();
export const calculateFare = (distance: number, category: string): number => {
  const baseFare = 50;
  let perKmRate = 0;

  if (distance > 8) {
    switch (category.toLowerCase()) {
      case "mini":
        perKmRate = 14;
        break;
      case "sedan":
        perKmRate = 17;
        break;
      case "suv":
        perKmRate = 27;
        break;
      default:
        perKmRate = 15;
    }
  } else {
    switch (category.toLowerCase()) {
      case "mini":
        perKmRate = 17;
        break;
      case "sedan":
        perKmRate = 23;
        break;
      case "suv":
        perKmRate = 35;
        break;
      default:
        perKmRate = 20;
    }
  }

  let fare = baseFare + distance * perKmRate;
  fare += getAdditionalCharges(distance, category);

  return fare;
};

const getAdditionalCharges = (distance: number, category: string): number => {
  let charges = 0;

  if (isEnteringDelhiFromNCR()) {
    charges += 100;
  }

  charges += getStateTaxCharges(distance, category);

  return charges;
};

const isEnteringDelhiFromNCR = (): boolean => {
  // Logic to determine if the route enters Delhi from NCR
  // This requires analysis of pickup and drop locations
  return false;
};

const getStateTaxCharges = (distance: number, category: string): number => {
  let stateTax = 0;
  const destinationState = getDestinationState();

  if (isTravelingFromDelhiTo(destinationState)) {
    switch (destinationState) {
      case "Haryana":
        if (
          category.toLowerCase() === "sedan" ||
          category.toLowerCase() === "suv"
        ) {
          stateTax = 100;
        }
        break;
      case "Uttar Pradesh":
        if (category.toLowerCase() === "sedan") {
          stateTax = 120;
        } else if (category.toLowerCase() === "suv") {
          stateTax = 200;
        }
        break;
    }
  }

  return stateTax;
};

const isTravelingFromDelhiTo = (state: string): boolean => {
  // Implement logic based on pickup and drop locations
  return false;
};

const getDestinationState = (): string => {
  // Determine the state from the drop location
  return "";
};
export const createRide = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation, carCategory } = req.body;
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const userId = req.user.userId;

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);
    const totalFare = calculateFare(distance, carCategory);

    const ride = await prisma.ride.create({
      data: {
        userId,
        pickupLocation,
        dropLocation,
        carCategory,
        fare: totalFare,
        distance,
        duration,
        status: RideStatus.SEARCHING,
        otp: generateOTP(),
      },
      include: {
        driver: true,
        user: {
          select: { name: true, phone: true },
        },
      },
    });

    // Search for drivers
    let radius = 3;
    let drivers = await searchAvailableDrivers(pickupLocation, radius);

    while (drivers.length === 0 && radius <= 15) {
      radius += 2;
      drivers = await searchAvailableDrivers(pickupLocation, radius);
    }

    if (drivers.length > 0) {
      // Notify drivers
      const io = req.app.get("io");
      drivers.forEach((driver) => {
        if (driver.socketId) {
          io.to(driver.socketId).emit("ride_request", {
            rideId: ride.id,
            pickupLocation,
            dropLocation,
            fare: totalFare,
            distance,
            duration,
            userId,
            userName: ride.user.name,
            userPhone: ride.user.phone,
          });
        }
      });

      console.log(
        "Notified drivers:",
        drivers.map((d) => d.driverId)
      );
    } else {
      // No drivers available
      await prisma.ride.update({
        where: { id: ride.id },
        data: { status: RideStatus.CANCELLED },
      });
      return res
        .status(200)
        .json({ message: "No drivers available at the moment." });
    }

    res.status(201).json(ride);
  } catch (error) {
    res.status(500).json({ error: "Failed to create ride" });
  }
};

/**
 * Generates a 4-digit OTP for ride verification.
 */
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Get ride details
// export const getRide = async (req: Request, res: Response) => {
//   const rideId = req.params.id;

//   if (!req.user) {
//     return res.status(401).json({ error: "Unauthorized" });
//   }
//   const { userId, userType } = req.user;

//   try {
//     // Allow ride fetch if you're either the user or the driver
//     const ride = await prisma.ride.findFirst({
//       where: {
//         id: rideId,
//         OR: [{ userId }, { driverId: userId }],
//       },
//       include: { driver: true, user: true },
//     });
//     const driverStatus = await prisma.driverStatus.findFirst({
//       where: { driverId: ride?.driverId ?? undefined },
//     });

//     if (!ride) {
//       return res.status(404).json({ error: "Ride not found" });
//     }

//     res.json({ ride, driverStatus });
//   } catch (error) {
//     res.status(500).json({ error: "Failed to retrieve ride" });
//   }
// };

export const getRide = async (req: Request, res: Response) => {
  const rideId = req.params.id;
  console.log(`Received request to fetch ride details for ID: ${rideId}`);

  if (!req.user) {
    console.log("Unauthorized access attempt.");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { userId, userType } = req.user;
  console.log(`Authenticated user ID: ${userId}, Type: ${userType}`);

  try {
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        OR: [
          { userId },
          userType === "DRIVER" ? { driverId: userId } : {}, // Ensure only drivers check driverId
        ],
      },
      include: { driver: true, user: true },
    });

    if (!ride) {
      console.log(`No ride found with ID: ${rideId} for user ID: ${userId}`);
      return res.status(404).json({ error: "Ride not found" });
    }

    console.log(`Ride found: ${JSON.stringify(ride)}`);

    const driverStatus = ride.driverId
      ? await prisma.driverStatus.findUnique({
          where: { driverId: ride.driverId },
        })
      : null;

    res.json({ ride, driverStatus });
  } catch (error) {
    console.error("Error fetching ride details:", error);
    res.status(500).json({ error: "Failed to retrieve ride details" });
  }
};

// Update ride status

// export const updateRideStatus = async (req: Request, res: Response) => {
//   const rideId = req.params.id;
//   const { status, otp } = req.body;
//   const userId = req.user?.userId;
//   const userType = req.user?.userType;

//   try {
//     const ride = await prisma.ride.findUnique({ where: { id: rideId } });

//     if (!ride) {
//       return res.status(404).json({ error: "Ride not found" });
//     }

//     // Only allow driver or user to update the ride status
//     if (
//       userType === "DRIVER" &&
//       ride.driverId !== userId &&
//       status !== "DRIVER_ARRIVED" &&
//       status !== "RIDE_STARTED" &&
//       status !== "RIDE_ENDED"
//     ) {
//       return res.status(403).json({ error: "Forbidden" });
//     }

//     if (
//       userType === "USER" &&
//       ride.userId !== userId &&
//       status !== "CANCELLED"
//     ) {
//       return res.status(403).json({ error: "Forbidden" });
//     }
//     if (status === "RIDE_STARTED") {
//       if (ride.otp !== otp) {
//         return res.status(400).json({ error: "Invalid OTP" });
//       }
//     }

//     const updatedRide = await prisma.ride.update({
//       where: { id: rideId },
//       data: { status },
//     });

//     // Emit real-time update to user and driver
//     io.to(ride.userId).emit("ride_status_update", { rideId, status });
//     if (ride.driverId) {
//       io.to(ride.driverId).emit("ride_status_update", { rideId, status });
//     }

//     res.json(updatedRide);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to update ride status" });
//   }
// };

export const updateRideStatus = async (req: Request, res: Response) => {
  const rideId = req.params.id;
  const { status, otp } = req.body;
  const userId = req.user?.userId;
  const userType = req.user?.userType;

  try {
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
    });

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" });
    }

    // Validate user permissions
    if (userType === "DRIVER") {
      if (ride.driverId !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!["DRIVER_ARRIVED", "RIDE_STARTED", "RIDE_ENDED"].includes(status)) {
        return res.status(400).json({ error: "Invalid status for driver" });
      }
    } else if (userType === "USER") {
      if (ride.userId !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (status !== "CANCELLED") {
        return res.status(400).json({ error: "Invalid status for user" });
      }
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Handle OTP validation when starting the ride
    if (status === "RIDE_STARTED") {
      if (ride.otp !== otp) {
        return res.status(400).json({ error: "Invalid OTP" });
      }
    }

    // Map string status to RideStatus enum
    let updatedStatus: RideStatus;

    switch (status) {
      case "SEARCHING":
        updatedStatus = RideStatus.SEARCHING;
        break;
      case "ACCEPTED":
        updatedStatus = RideStatus.ACCEPTED;
        break;
      case "DRIVER_ARRIVED":
        updatedStatus = RideStatus.DRIVER_ARRIVED;
        break;
      case "RIDE_STARTED":
        updatedStatus = RideStatus.RIDE_STARTED;
        break;
      case "RIDE_ENDED":
        updatedStatus = RideStatus.RIDE_ENDED;
        break;
      case "CANCELLED":
        updatedStatus = RideStatus.CANCELLED;
        break;
      default:
        return res.status(400).json({ error: "Invalid ride status" });
    }
    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: { status: updatedStatus },
      include: { user: true, driver: true },
    });

    // Emit real-time update to user and driver
    if (ride.userId) {
      io.to(ride.userId).emit("ride_status_update", {
        rideId,
        status: updatedStatus,
      });
    }

    if (ride.driverId) {
      io.to(ride.driverId).emit("ride_status_update", {
        rideId,
        status: updatedStatus,
      });
    }

    res.json(updatedRide);
  } catch (error) {
    console.error("Error updating ride status:", error);
    res.status(500).json({ error: "Failed to update ride status" });
  }
};

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

export const calculateDistance = async (
  pickup: string,
  drop: string
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
        pickup
      )}&destinations=${encodeURIComponent(drop)}&key=${GOOGLE_MAPS_API_KEY}`
    );
    const distanceInMeters = response.data.rows[0].elements[0].distance.value;
    return distanceInMeters / 1000; // Convert to kilometers
  } catch (error) {
    console.error("Error calculating distance:", error);
    return 0;
  }
};

export const calculateDuration = async (
  pickup: string,
  drop: string
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
        pickup
      )}&destinations=${encodeURIComponent(drop)}&key=${GOOGLE_MAPS_API_KEY}`
    );
    const durationInSeconds = response.data.rows[0].elements[0].duration.value;
    return Math.ceil(durationInSeconds / 60); // Convert to minutes
  } catch (error) {
    console.error("Error calculating duration:", error);
    return 0;
  }
};
