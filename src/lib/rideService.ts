// import type { Request, Response } from "express";
// import { PrismaClient, RideStatus } from "@prisma/client";

// import { searchAvailableDrivers } from "../services/driverService";
// import { io } from "../server";

// const prisma = new PrismaClient();

// export const calculateFare = (distance: number, category: string): number => {
//   const baseFare = 50.0;
//   let perKmRate = 0.0;

//   if (distance > 8) {
//     switch (category.toLowerCase()) {
//       case "mini":
//         perKmRate = 14.0;
//         break;
//       case "sedan":
//         perKmRate = 17.0;
//         break;
//       case "suv":
//         perKmRate = 27.0;
//         break;
//       default:
//         perKmRate = 15.0;
//     }
//   } else if (distance >= 1 && distance <= 8) {
//     switch (category.toLowerCase()) {
//       case "mini":
//         perKmRate = 17.0;
//         break;
//       case "sedan":
//         perKmRate = 23.0;
//         break;
//       case "suv":
//         perKmRate = 35.0;
//         break;
//       default:
//         perKmRate = 20.0;
//     }
//   }

//   const fare = baseFare + distance * perKmRate;
//   let additionalCharges = 0.0;

//   if (isEnteringDelhiFromNCR()) {
//     additionalCharges += 100.0;
//   }

//   additionalCharges += getStateTaxCharges(category);

//   return fare + additionalCharges;
// };

// const isEnteringDelhiFromNCR = (): boolean => {
//   // Implement actual logic
//   return false;
// };

// const getStateTaxCharges = (category: string): number => {
//   let stateTax = 0.0;

//   if (isTravelingFromDelhiTo("Haryana")) {
//     switch (category.toLowerCase()) {
//       case "sedan":
//         stateTax = 100.0;
//         break;
//       case "suv":
//         stateTax = 100.0;
//         break;
//     }
//   } else if (isTravelingFromDelhiTo("Uttar Pradesh")) {
//     switch (category.toLowerCase()) {
//       case "sedan":
//         stateTax = 120.0;
//         break;
//       case "suv":
//         stateTax = 200.0;
//         break;
//     }
//   }

//   return stateTax;
// };

// const isTravelingFromDelhiTo = (state: string): boolean => {
//   // Implement actual logic based on ride data
//   return false;
// };

// // Create a new ride
// export const createRide = async (req: Request, res: Response) => {
//   const { pickupLocation, dropLocation, carCategory, fare } = req.body;
//   if (!req.user) {
//     return res.status(401).json({ error: "Unauthorized" });
//   }
//   const userId = req.user.userId;

//   try {
//     const distance = await calculateDistance(pickupLocation, dropLocation);
//     const duration = await calculateDuration(pickupLocation, dropLocation);
//     const totalFare = calculateFare(distance, carCategory);

//     const ride = await prisma.ride.create({
//       data: {
//         userId,
//         pickupLocation,
//         dropLocation,
//         carCategory,
//         fare,
//         distance,
//         duration,
//         status: RideStatus.SEARCHING,
//         totalAmount: totalFare,
//       },
//     });

//     // Emit event to search for drivers
//     io.emit("search_driver", { rideId: ride.id, pickupLocation });

//     res.status(201).json(ride);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to create ride" });
//   }
// };

// // Get ride details
// export const getRide = async (req: Request, res: Response) => {
//   const rideId = req.params.id;
//   if (!req.user) {
//     return res.status(401).json({ error: "Unauthorized" });
//   }
//   const userId = req.user.userId;

//   try {
//     const ride = await prisma.ride.findFirst({
//       where: { id: rideId, userId },
//       include: { driver: true },
//     });

//     if (!ride) {
//       return res.status(404).json({ error: "Ride not found" });
//     }

//     res.json(ride);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to retrieve ride" });
//   }
// };

// // Update ride status
// export const updateRideStatus = async (req: Request, res: Response) => {
//   const rideId = req.params.id;
//   const { status, otp } = req.body;
//   if (!req.user) {
//     return res.status(401).json({ error: "Unauthorized" });
//   }
//   const userId = req.user.userId;

//   try {
//     const ride = await prisma.ride.findFirst({
//       where: { id: rideId, userId },
//     });

//     if (!ride) {
//       return res.status(404).json({ error: "Ride not found" });
//     }

//     if (status === RideStatus.RIDE_STARTED && ride.otp !== otp) {
//       return res.status(400).json({ error: "Invalid OTP" });
//     }

//     const updatedRide = await prisma.ride.update({
//       where: { id: rideId },
//       data: { status },
//     });

//     // Emit real-time update
//     io.emit("ride_status_update", { rideId, status });

//     res.json(updatedRide);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to update ride status" });
//   }
// };

// // Helper functions (Placeholder implementations)
// const calculateDistance = async (
//   pickup: string,
//   drop: string
// ): Promise<number> => {
//   // Integrate Google Maps API to calculate distance
//   return 10.0;
// };

// const calculateDuration = async (
//   pickup: string,
//   drop: string
// ): Promise<number> => {
//   // Integrate Google Maps API to calculate duration
//   return 15;
// };
