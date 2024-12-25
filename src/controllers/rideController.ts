// ride-controller.ts
import type { Request, Response } from "express";
import {
  PrismaClient,
  RideStatus,
  PaymentMode,
  UserType,
} from "@prisma/client";
import { searchAvailableDrivers } from "../lib/driverService";

import {
  handleCashPayment,
  calculateFinalAmount,
  initiateRazorpayPayment,
} from "./paymentController";

import { io } from "../server";
import axios from "axios";

const prisma = new PrismaClient();
const WAIT_TIME_THRESHOLD = 5; // minutes
const EXTRA_CHARGE_PER_MINUTE = 2;
const DRIVER_REQUEST_TIMEOUT = 15000; // 30 seconds
const MAX_SEARCH_RADIUS = 15; // kilometers
const INITIAL_SEARCH_RADIUS = 3; // kilometers

//  fare estimation endpoint for Delhi/ncr rides -frontend
export const getFareEstimation = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation } = req.body;

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);

    // Calculate fares for all categories
    const miniFare = calculateFare(distance, "mini");
    const sedanFare = calculateFare(distance, "sedan");
    const suvFare = calculateFare(distance, "suv");

    res.json({
      estimates: {
        mini: {
          fare: miniFare,
          distance,
          duration,
          currency: "INR",
        },
        sedan: {
          fare: sedanFare,
          distance,
          duration,
          currency: "INR",
        },
        suv: {
          fare: suvFare,
          distance,
          duration,
          currency: "INR",
        },
      },
    });
  } catch (error) {
    console.error("Error in fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

// Helper function to initialize ride record
async function initializeRide(
  userId: string,
  pickupLocation: string,
  dropLocation: string,
  carCategory: string,
  paymentMode: PaymentMode | undefined
) {
  const distance = await calculateDistance(pickupLocation, dropLocation);
  const duration = await calculateDuration(pickupLocation, dropLocation);
  const totalFare = calculateFare(distance, carCategory);

  return prisma.ride.create({
    data: {
      userId,
      pickupLocation,
      dropLocation,
      carCategory,
      fare: totalFare,
      distance,
      duration,
      status: RideStatus.SEARCHING,
      paymentMode: paymentMode || PaymentMode.CASH,
      otp: generateOTP().toString(),
      waitStartTime: null,
      extraCharges: 0,
    },
    include: {
      user: {
        select: { name: true, phone: true },
      },
    },
  });
}

export const createRide = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation, carCategory, paymentMode } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const userId = req.user.userId;

  try {
    // Create initial ride record with SEARCHING status
    const ride = await initializeRide(
      userId,
      pickupLocation,
      dropLocation,
      carCategory,
      paymentMode
    );

    // Start driver search process
    const driverSearchResult = await findAndRequestDrivers(ride);

    // If no driver was found, mark ride as cancelled
    if (!driverSearchResult.success) {
      const cancelledRide = await updateRideInDatabase(
        ride.id,
        RideStatus.CANCELLED
      );
      return res.status(200).json({
        message: driverSearchResult.message,
        searchedDrivers: driverSearchResult.searchedDrivers,
        ride: cancelledRide,
      });
    }

    // Return successful response with ride details and driver search info
    return res.status(201).json({
      ride: driverSearchResult.ride,
      message: driverSearchResult.message,
      searchedDrivers: driverSearchResult.searchedDrivers,
      finalRadius: driverSearchResult.finalRadius,
    });
  } catch (error) {
    console.error("Error in createRide:", error);
    res.status(500).json({ error: "Failed to create ride" });
  }
};

async function findAndRequestDrivers(ride: any) {
  let currentRadius = INITIAL_SEARCH_RADIUS;
  const attemptedDrivers = new Set<string>();
  const searchedDrivers: any[] = [];

  while (currentRadius <= MAX_SEARCH_RADIUS) {
    const drivers = await searchAvailableDrivers(
      ride.pickupLocation,
      currentRadius
    );
    const newDrivers = drivers.filter((d) => !attemptedDrivers.has(d.driverId));

    if (newDrivers.length > 0) {
      searchedDrivers.push(
        ...newDrivers.map((d) => ({
          driverId: d.driverId,
          distance: d.distance,
          status: "searched",
        }))
      );

      for (const driver of newDrivers) {
        // Check if ride is already accepted
        const currentRide = await prisma.ride.findUnique({
          where: { id: ride.id },
          include: {
            driver: {
              select: {
                id: true,
                name: true,
                phone: true,
                driverDetails: true,
              },
            },
          },
        });

        if (currentRide?.status === RideStatus.ACCEPTED) {
          // Get driver's current location
          const driverStatus = await prisma.driverStatus.findUnique({
            where: { driverId: currentRide.driverId! },
          });

          if (driverStatus) {
            // Calculate and update pickup metrics
            const pickupDistance = await calculateDistance(
              `${driverStatus.locationLat},${driverStatus.locationLng}`,
              ride.pickupLocation
            );
            const pickupDuration = await calculateDuration(
              `${driverStatus.locationLat},${driverStatus.locationLng}`,
              ride.pickupLocation
            );

            const updatedRide = await prisma.ride.update({
              where: { id: ride.id },
              data: {
                pickupDistance,
                pickupDuration,
              },
              include: {
                driver: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    driverDetails: true,
                  },
                },
              },
            });

            return {
              success: true,
              message: "Ride already accepted by another driver",
              searchedDrivers,
              finalRadius: currentRadius,
              ride: updatedRide,
            };
          }
        }

        attemptedDrivers.add(driver.driverId);

        if (!driver.socketId) {
          continue;
        }

        try {
          // Calculate pickup distance and duration before emitting request
          const pickupDistance = await calculateDistance(
            `${driver.locationLat},${driver.locationLng}`,
            ride.pickupLocation
          );

          const pickupDuration = await calculateDuration(
            `${driver.locationLat},${driver.locationLng}`,
            ride.pickupLocation
          );

          // Emit ride request to driver with pickup metrics
          io.to(driver.socketId).emit("ride_request", {
            rideId: ride.id,
            pickupLocation: ride.pickupLocation,
            dropLocation: ride.dropLocation,
            fare: ride.fare,
            distance: ride.distance,
            duration: ride.duration,
            PaymentMode: ride.paymentMode,
            pickupDistance,
            pickupDuration,
            userId: ride.userId,
            userName: ride.user.name,
            userPhone: ride.user.phone,
          });

          console.log(`Ride request sent to driver ${driver.driverId}`);

          const response: any = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              resolve({ accepted: false });
            }, DRIVER_REQUEST_TIMEOUT);

            io.once(
              `driver_response_${ride.id}_${driver.driverId}`,
              (response) => {
                clearTimeout(timeout);
                resolve(response);
              }
            );
          });

          if (response.accepted) {
            // Immediately update ride with ACCEPTED status and pickup metrics
            const updatedRide = await prisma.ride.update({
              where: {
                id: ride.id,
                status: RideStatus.SEARCHING, // Only update if still searching
              },
              data: {
                driverId: driver.driverId,
                status: RideStatus.ACCEPTED,
                pickupDistance: pickupDistance,
                pickupDuration: pickupDuration,
              },
              include: {
                driver: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    driverDetails: true,
                  },
                },
              },
            });

            // If update was successful, stop searching and return
            if (updatedRide) {
              return {
                success: true,
                message: "Driver found successfully",
                searchedDrivers,
                finalRadius: currentRadius,
                ride: updatedRide,
              };
            }
          }
        } catch (error) {
          console.error(`Error requesting driver ${driver.driverId}:`, error);
          continue;
        }
      }
    }
    currentRadius += 2;
  }

  return {
    success: false,
    message: "No available drivers found",
    searchedDrivers,
    finalRadius: currentRadius - 2,
  };
}

//  updateRideStatus with wait timer and extra charges
export const updateRideStatus = async (req: Request, res: Response) => {
  const rideId = req.params.id;
  const { status, otp } = req.body;
  const userId = req.user?.userId;
  const userType = req.user?.userType;

  try {
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { driver: true },
    });

    if (!ride) return res.status(404).json({ error: "Ride not found" });

    // Permission validation
    if (!validatePermissions(userType as UserType, userId, ride, status)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // status-specific logic
    switch (status) {
      case "DRIVER_ARRIVED":
        await handleDriverArrival(ride);
        break;
      case "RIDE_STARTED":
        if (!validateOTP(ride, otp)) {
          return res.status(400).json({ error: "Invalid OTP" });
        }
        await calculateWaitingCharges(ride);
        break;
      case "RIDE_ENDED":
        return handleRideCompletion(req, res);
      case "CANCELLED":
        if (!userType)
          return res.status(403).json({ error: "User type is required" });
        return handleRideCancellation(ride, userType, res);
    }

    const updatedRide = await updateRideInDatabase(rideId, status);
    emitRideStatusUpdate(ride, status);
    res.json(updatedRide);
  } catch (error) {
    res.status(500).json({ error: "Failed to update ride status" });
  }
};

// Helper functions
const validatePermissions = (
  userType: UserType | undefined,
  userId: string | undefined,
  ride: any,
  status: RideStatus
): boolean => {
  if (!userType) return false;
  if (userType === "DRIVER") {
    return (
      ride.driverId === userId &&
      ["DRIVER_ARRIVED", "RIDE_STARTED", "RIDE_ENDED"].includes(status)
    );
  }
  if (userType === "USER") {
    return ride.userId === userId && status === "CANCELLED";
  }
  return false;
};

const handleDriverArrival = async (ride: any) => {
  await prisma.ride.update({
    where: { id: ride.id },
    data: { waitStartTime: new Date() },
  });
};

const calculateWaitingCharges = async (ride: any) => {
  if (ride.waitStartTime) {
    const waitDuration = Math.floor(
      (new Date().getTime() - new Date(ride.waitStartTime).getTime()) / 60000
    );
    if (waitDuration > WAIT_TIME_THRESHOLD) {
      const extraCharges =
        (waitDuration - WAIT_TIME_THRESHOLD) * EXTRA_CHARGE_PER_MINUTE;
      await prisma.ride.update({
        where: { id: ride.id },
        data: {
          extraCharges,
          fare: { increment: extraCharges },
        },
      });
    }
  }
};
export const handleRideCompletion = async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const { finalLocation } = req.body;

  if (!rideId) {
    return res.status(400).json({ error: "Ride ID is required" });
  }

  try {
    // First find the ride
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        status: RideStatus.RIDE_STARTED, // Only allow completion of started rides
      },
      include: {
        user: true,
        driver: true,
      },
    });

    if (!ride) {
      return res.status(404).json({
        error: "Ride not found or invalid status",
        details: "Ride must be in RIDE_STARTED status to end it",
      });
    }

    // Calculate final amount including any extra charges
    const finalAmount = calculateFinalAmount(ride);

    // Update ride with final details
    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: {
        dropLocation: finalLocation || ride.dropLocation,
        totalAmount: finalAmount,
        status:
          ride.paymentMode === PaymentMode.CASH
            ? RideStatus.RIDE_ENDED
            : RideStatus.PAYMENT_PENDING,
      },
      include: {
        user: true,
        driver: true,
      },
    });

    // Emit ride completion event
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      finalLocation,
      amount: finalAmount,
      paymentMode: ride.paymentMode,
    });

    // Handle payment based on mode
    if (ride.paymentMode === PaymentMode.CASH) {
      return res.json({
        success: true,
        message: "Ride completed, awaiting cash collection",
        ride: updatedRide,
      });
    } else {
      const paymentDetails = await initiateRazorpayPayment(updatedRide);
      return res.json({
        success: true,
        message: "Payment initiated",
        ride: updatedRide,
        paymentDetails,
      });
    }
  } catch (error: any) {
    console.error("Error completing ride:", error);
    return res.status(500).json({
      error: "Failed to complete ride",
      message: error.message,
    });
  }
};

const handleRideCancellation = async (
  ride: any,
  userType: string,
  res: Response
) => {
  await prisma.ride.update({
    where: { id: ride.id },
    data: { status: RideStatus.CANCELLED },
  });

  emitRideStatusUpdate(ride, "CANCELLED");
  res.json({ success: true, message: "Ride cancelled successfully" });
};

const updateRideInDatabase = async (rideId: string, status: RideStatus) => {
  return prisma.ride.update({
    where: { id: rideId },
    data: {
      status,
      ...(status === RideStatus.CANCELLED ? { driverId: null } : {}),
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
};

// emitRideStatusUpdate function -> driver and user notifications

const emitRideStatusUpdate = (ride: any, status: string) => {
  if (ride.userId) {
    io.to(ride.userId).emit("ride_status_update", {
      rideId: ride.id,
      status,
    });
  }
  if (ride.driverId) {
    io.to(ride.driverId).emit("ride_status_update", {
      rideId: ride.id,
      status,
    });
  }
};

// get ride details endpoint
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

// calculateFare function -> Delhi/ncr rides
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

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

// calculateDistance and calculateDuration functions -> Delhi/ncr rides

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

const generateOTP = (): number => {
  return Math.floor(1000 + Math.random() * 9000);
};

const validateOTP = (ride: any, otp: number): boolean => {
  return ride.otp === otp;
};
