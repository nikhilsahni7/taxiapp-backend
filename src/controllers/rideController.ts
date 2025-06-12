// ride-controller.ts
import {
  CancelledBy,
  PaymentMode,
  PrismaClient,
  RideStatus,
  RideType,
  TransactionStatus,
  TransactionType,
  UserType,
} from "@prisma/client";
import type { Request, Response } from "express";
import { searchAvailableDrivers } from "../lib/driverService";

import {
  sendTaxiSureBookingNotification,
  sendTaxiSureCancellationNotification,
  sendTaxiSureRegularNotification,
  validateFcmToken,
} from "../utils/sendFcmNotification";
import {
  calculateFinalAmount,
  initiateRazorpayPayment,
} from "./paymentController";

import axios from "axios";
import { io } from "../server";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

const prisma = new PrismaClient();

// Wait time constants
const FREE_WAITING_MINUTES = 3; // Free waiting period in minutes
const WAITING_CHARGE_PER_MINUTE = 3; // Rs 3 per minute after free period
const DRIVER_REQUEST_TIMEOUT = 15000;
const MAX_SEARCH_RADIUS = 15; // kilometers
const INITIAL_SEARCH_RADIUS = 3; // kilometers
const CARRIER_CHARGE = 30; // Fixed carrier charge in INR

interface Location {
  lat: number;
  lng: number;
}

interface TaxAndCharges {
  stateTax: number;
  tollCharges: number;
  airportCharges: number;
  mcdCharges: number;
}

// Define valid car categories in lowercase
type CarCategory = "mini" | "sedan" | "suv";

// Type for state tax structure
type StateTaxStructure = {
  [K in CarCategory]: number;
};

// Constants for different charges with proper typing
const CHARGES = {
  MCD_CHARGE: 100,
  AIRPORT_PARKING: 290,
  STATE_TAX: {
    DELHI_TO_HARYANA: {
      mini: 100,
      sedan: 100,
      suv: 100,
    } as StateTaxStructure,
    DELHI_TO_UP: {
      mini: 120,
      sedan: 120,
      suv: 200,
    } as StateTaxStructure,
    HARYANA_TO_UP: {
      mini: 220, // 100 (Delhi to Haryana) + 120 (Delhi to UP)
      sedan: 220, // 100 (Delhi to Haryana) + 120 (Delhi to UP)
      suv: 300, // 100 (Delhi to Haryana) + 200 (Delhi to UP)
    } as StateTaxStructure,
    UP_TO_HARYANA: {
      mini: 220, // 120 (UP to Delhi) + 100 (Delhi to Haryana)
      sedan: 220, // 120 (UP to Delhi) + 100 (Delhi to Haryana)
      suv: 300, // 200 (UP to Delhi) + 100 (Delhi to Haryana)
    } as StateTaxStructure,
  },

  // Add reference for major airports
  MAJOR_AIRPORTS: [
    "Indira Gandhi International Airport",
    "IGI Airport",
    "Noida International Airport",
    "Hindon Airport",
  ],
} as const;

// Function to validate car category
function isValidCategory(category: string): category is CarCategory {
  return ["mini", "sedan", "suv"].includes(category.toLowerCase());
}

// Rest of the coordinate and location functions remain the same
async function getCoordinates(address: string): Promise<Location> {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        address
      )}&key=${process.env.GOOGLE_MAPS_API_KEY}`
    );
    const location = response.data.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  } catch (error) {
    console.error("Error getting coordinates:", error);
    throw new Error("Failed to get coordinates");
  }
}

async function getStateFromCoordinates(location: Location): Promise<string> {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${location.lat},${location.lng}&key=${process.env.GOOGLE_MAPS_API_KEY}`
    );

    const addressComponents = response.data.results[0].address_components;
    const state = addressComponents.find((component: any) =>
      component.types.includes("administrative_area_level_1")
    );

    return state ? state.long_name : "";
  } catch (error) {
    console.error("Error getting state:", error);
    return "";
  }
}

// Calculate all applicable taxes and charges
async function calculateTaxAndCharges(
  pickupLocation: string,
  dropLocation: string,
  category: string
): Promise<TaxAndCharges> {
  const pickup = await getCoordinates(pickupLocation);
  const drop = await getCoordinates(dropLocation);

  const pickupState = await getStateFromCoordinates(pickup);
  const dropState = await getStateFromCoordinates(drop);

  let stateTax = 0;
  let mcdCharges = 0;
  let airportCharges = 0;

  // Convert and validate category
  const lowerCategory = category.toLowerCase();
  if (!isValidCategory(lowerCategory)) {
    console.warn(`Invalid category: ${category}, defaulting to no state tax`);
    return {
      stateTax: 0,
      tollCharges: 0,
      airportCharges: 0,
      mcdCharges: 0,
    };
  }

  // Calculate state tax and MCD charges based on route
  if (pickupState === "Haryana" && dropState === "Uttar Pradesh") {
    // Haryana to UP route (includes both taxes since it goes via Delhi)
    stateTax = CHARGES.STATE_TAX.HARYANA_TO_UP[lowerCategory];
  } else if (pickupState === "Uttar Pradesh" && dropState === "Haryana") {
    // UP to Haryana route (includes both taxes since it goes via Delhi)
    stateTax = CHARGES.STATE_TAX.UP_TO_HARYANA[lowerCategory];
  } else if (pickupState === "Delhi" && dropState === "Haryana") {
    stateTax = CHARGES.STATE_TAX.DELHI_TO_HARYANA[lowerCategory];
  } else if (pickupState === "Delhi" && dropState === "Uttar Pradesh") {
    stateTax = CHARGES.STATE_TAX.DELHI_TO_UP[lowerCategory];
  } else if (pickupState !== "Delhi" && dropState === "Delhi") {
    // Any state to Delhi route
    mcdCharges = CHARGES.MCD_CHARGE;
  }

  // Apply airport charges if applicable
  if (
    pickupLocation.toLowerCase().includes("terminal 1") ||
    pickupLocation.toLowerCase().includes("terminal 2") ||
    pickupLocation.toLowerCase().includes("terminal 3") ||
    pickupLocation.toLowerCase().includes("t1") ||
    pickupLocation.toLowerCase().includes("t2") ||
    pickupLocation.toLowerCase().includes("t3")
  ) {
    airportCharges = CHARGES.AIRPORT_PARKING;
  }

  return {
    stateTax,
    tollCharges: 0, // Toll charges are not currently implemented
    airportCharges,
    mcdCharges,
  };
}

interface FareEstimate {
  baseFare: number;
  totalFare: number;
  charges: TaxAndCharges;
  distance: number;
  duration: number;
  currency: string;
  carrierCharge?: number;
}

// Enhanced fare calculation function
export const calculateFare = async (
  pickupLocation: string,
  dropLocation: string,
  distance: number,
  category: string,
  carrierRequested: boolean = false
): Promise<{
  baseFare: number;
  totalFare: number;
  charges: TaxAndCharges;
  carrierCharge?: number;
}> => {
  const baseFare = 50;
  let perKmRate = 0;

  // Import fare service dynamically to avoid circular dependencies
  const { fareService } = await import("../services/fareService");

  try {
    // Get dynamic rates from database
    if (distance > 8) {
      perKmRate = await fareService.getRate(
        "LOCAL",
        category.toLowerCase(),
        "PER_KM_LONG"
      );
    } else {
      perKmRate = await fareService.getRate(
        "LOCAL",
        category.toLowerCase(),
        "PER_KM_SHORT"
      );
    }
  } catch (error) {
    console.error("Error getting dynamic rates, using fallback:", error);
    // Fallback to hardcoded rates
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
  }

  const charges = await calculateTaxAndCharges(
    pickupLocation,
    dropLocation,
    category
  );

  const distanceFare = distance * perKmRate;
  const baseTotalFare =
    baseFare +
    distanceFare +
    charges.stateTax +
    charges.tollCharges +
    charges.airportCharges +
    charges.mcdCharges;

  // Add carrier charge if requested
  const carrierCharge = carrierRequested ? CARRIER_CHARGE : 0;
  const totalFare = baseTotalFare + carrierCharge;

  return {
    baseFare: baseFare + distanceFare,
    totalFare,
    charges,
    carrierCharge: carrierRequested ? CARRIER_CHARGE : undefined,
  };
};

// Update the getFareEstimation endpoint
export const getFareEstimation = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation, carrierRequested } = req.body;
  const userId = req.user?.userId; // Get user ID from authentication middleware

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);

    // Calculate fares for all categories with taxes and charges
    const categories: CarCategory[] = ["mini", "sedan", "suv"];
    const estimates: Record<CarCategory, FareEstimate> = {} as Record<
      // <-- Removed outstanding fee from type
      CarCategory,
      FareEstimate // <-- Removed outstanding fee from type
    >;

    for (const category of categories) {
      const fareDetails = await calculateFare(
        pickupLocation,
        dropLocation,
        distance,
        category,
        carrierRequested
      );

      estimates[category] = {
        ...fareDetails,
        distance,
        duration,
        currency: "INR",
        totalFare: fareDetails.totalFare, // <-- Use the original totalFare without the fee
        carrierCharge: fareDetails.carrierCharge,
      };
    }

    res.json({
      estimates,
      carrierRequested: carrierRequested || false,
    });
  } catch (error) {
    console.error("Error in fare estimation:", error);
    res.status(500).json({ error: "Failed to calculate fare estimation" });
  }
};

async function calculatePickupMetrics(driver: any, pickupLocation: string) {
  const pickupDistance = await calculateDistance(
    `${driver.locationLat},${driver.locationLng}`,
    pickupLocation
  );
  const pickupDuration = await calculateDuration(
    `${driver.locationLat},${driver.locationLng}`,
    pickupLocation
  );
  return { pickupDistance, pickupDuration };
}

// Helper function to wait for driver response
function waitForDriverResponse(
  rideId: string,
  driverId: string
): Promise<{ accepted: boolean }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ accepted: false });
    }, DRIVER_REQUEST_TIMEOUT);

    io.once(`driver_response_${rideId}_${driverId}`, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

// Helper function to initialize ride record
async function initializeRide(
  userId: string,
  pickupLocation: string,
  dropLocation: string,
  carCategory: string,
  paymentMode: PaymentMode | undefined,
  carrierRequested: boolean = false
) {
  const distance = await calculateDistance(pickupLocation, dropLocation);
  const duration = await calculateDuration(pickupLocation, dropLocation);
  const fareDetails = await calculateFare(
    pickupLocation,
    dropLocation,
    distance,
    carCategory,
    carrierRequested
  );

  return prisma.ride.create({
    data: {
      userId,
      pickupLocation,
      dropLocation,
      carCategory,
      fare: fareDetails.totalFare,
      distance,
      duration,
      status: RideStatus.SEARCHING,
      paymentMode: paymentMode || PaymentMode.CASH,
      otp: generateOTP().toString(),
      waitingStartTime: null,
      waitingMinutes: 0,
      waitingCharges: 0,
      extraCharges: 0,
      carrierRequested: carrierRequested,
      carrierCharge: carrierRequested ? CARRIER_CHARGE : 0,
    },
    include: {
      user: {
        select: { name: true, phone: true },
      },
    },
  });
}

async function findAndRequestDrivers(ride: any) {
  const RIDE_SEARCH_TOTAL_TIMEOUT_MS = 60000; // 60 seconds overall
  const RADIUS_EXPANSION_INTERVAL_MS = 15000; // Expand radius every 15s
  const DRIVER_INDIVIDUAL_RESPONSE_TIMEOUT_MS = 15000; // Driver has 15s to respond

  const searchDeadline = Date.now() + RIDE_SEARCH_TOTAL_TIMEOUT_MS;
  let currentRadius = INITIAL_SEARCH_RADIUS;
  const attemptedDrivers = new Set<string>(); // Tracks driverIds to whom request has been sent for this ride
  let rideAccepted = false;
  let winningRideDetails: any = null; // Store the successfully updated ride object

  // Arrays to keep track of active listeners and timeouts for cleanup
  const activeListeners: Array<{
    eventName: string;
    listener: (...args: any[]) => void;
  }> = [];
  const driverIndividualTimeouts: Array<ReturnType<typeof setTimeout>> = []; // Use ReturnType for correct timeout type

  const cleanupSystem = () => {
    activeListeners.forEach(({ eventName, listener }) =>
      io.off(eventName, listener)
    );
    driverIndividualTimeouts.forEach(clearTimeout);
    activeListeners.length = 0;
    driverIndividualTimeouts.length = 0;
    console.log(
      `[findAndRequestDrivers] Cleanup for ride ${ride.id} completed.`
    );
  };

  try {
    while (
      Date.now() < searchDeadline &&
      currentRadius <= MAX_SEARCH_RADIUS &&
      !rideAccepted
    ) {
      const iterationStartTime = Date.now();

      const currentRideState = await prisma.ride.findUnique({
        where: { id: ride.id },
        select: { status: true },
      });

      if (rideAccepted || currentRideState?.status !== RideStatus.SEARCHING) {
        if (rideAccepted)
          console.log(
            `[findAndRequestDrivers] Ride ${ride.id} already accepted, breaking loop.`
          );
        else
          console.log(
            `[findAndRequestDrivers] Ride ${ride.id} status changed to ${currentRideState?.status}, breaking loop.`
          );
        break;
      }

      const filterOptions: { hasCarrier?: boolean; carCategory?: string } = {};
      if (ride.carrierRequested) filterOptions.hasCarrier = true;
      if (ride.carCategory) filterOptions.carCategory = ride.carCategory;

      console.log(
        `[findAndRequestDrivers] Ride ${ride.id}: Searching drivers in radius ${currentRadius}km. Filters:`,
        filterOptions
      );
      const availableDrivers = await searchAvailableDrivers(
        ride.pickupLocation,
        currentRadius,
        filterOptions
      );

      const newDriversToRequest = availableDrivers.filter(
        (d) => d.driverId && !attemptedDrivers.has(d.driverId) && d.socketId
      );

      if (newDriversToRequest.length > 0) {
        console.log(
          `[findAndRequestDrivers] Ride ${ride.id}: Found ${newDriversToRequest.length} new drivers. Sending requests concurrently.`
        );

        const acceptancePromises = newDriversToRequest.map((driver) => {
          attemptedDrivers.add(driver.driverId);

          return new Promise<any>(async (resolve, reject) => {
            if (rideAccepted) {
              return reject(
                `[Driver: ${driver.driverId}] Ride ${ride.id} already accepted by another driver (pre-check).`
              );
            }

            const eventName = `driver_response_${ride.id}_${driver.driverId}`;
            let individualTimeoutId: ReturnType<typeof setTimeout>; // Use ReturnType

            const responseListener = async (response: {
              accepted: boolean;
            }) => {
              clearTimeout(individualTimeoutId);
              io.off(eventName, responseListener);

              if (rideAccepted) {
                return reject(
                  `[Driver: ${driver.driverId}] Ride ${ride.id} accepted by another after this one responded.`
                );
              }

              if (response.accepted) {
                console.log(
                  `[findAndRequestDrivers] Ride ${ride.id}: Driver ${driver.driverId} accepted. Attempting to secure ride.`
                );
                const pickupMetrics = await calculatePickupMetrics(
                  driver,
                  ride.pickupLocation
                );

                try {
                  const updatedRide = await prisma.$transaction(async (tx) => {
                    const finalCheck = await tx.ride.findFirst({
                      where: {
                        id: ride.id,
                        status: RideStatus.SEARCHING,
                        driverId: null,
                      },
                    });
                    if (!finalCheck) {
                      console.log(
                        `[findAndRequestDrivers] Ride ${ride.id}: Transaction check failed (already taken/cancelled).`
                      );
                      return null;
                    }
                    return tx.ride.update({
                      where: { id: ride.id },
                      data: {
                        driverId: driver.driverId,
                        status: RideStatus.ACCEPTED,
                        pickupDistance: pickupMetrics.pickupDistance,
                        pickupDuration: pickupMetrics.pickupDuration,
                      },
                      include: {
                        driver: {
                          select: {
                            id: true,
                            name: true,
                            phone: true,
                            selfieUrl: true,

                            driverDetails: {
                              select: {
                                vehicleName: true,
                                vehicleNumber: true,
                                hasCarrier: true,
                              },
                            },
                          },
                        },
                        user: {
                          select: {
                            id: true,
                            name: true,
                            phone: true,
                          },
                        },
                      },
                    });
                  });

                  if (updatedRide) {
                    if (!rideAccepted) {
                      rideAccepted = true;
                      winningRideDetails = { ...updatedRide, pickupMetrics };
                      console.log(
                        `[findAndRequestDrivers] Ride ${ride.id}: Successfully secured by driver ${driver.driverId}.`
                      );
                      resolve(winningRideDetails); // This driver's promise resolves with success
                    } else {
                      // This driver accepted, but another one was processed faster.
                      console.log(
                        `[findAndRequestDrivers] Ride ${ride.id}: Driver ${driver.driverId} accepted, but ride already secured by another.`
                      );
                      io.to(driver.socketId!).emit("ride_acceptance_failed", {
                        rideId: ride.id,
                        reason: "already_accepted",
                        message:
                          "This ride was accepted by another driver just moments ago.",
                      });
                      reject(
                        `[Driver: ${driver.driverId}] Race condition: Ride ${ride.id} was accepted by another driver during transaction.`
                      );
                    }
                  } else {
                    // Transaction failed, meaning ride was likely taken or cancelled during the attempt.
                    console.log(
                      `[findAndRequestDrivers] Ride ${ride.id}: Driver ${driver.driverId} accepted, but transaction failed (ride likely taken/cancelled).`
                    );
                    io.to(driver.socketId!).emit("ride_acceptance_failed", {
                      rideId: ride.id,
                      reason: "ride_unavailable",
                      message:
                        "This ride is no longer available or was cancelled.",
                    });
                    reject(
                      `[Driver: ${driver.driverId}] Failed to secure ride ${ride.id} in transaction (already taken/cancelled).`
                    );
                  }
                } catch (txError) {
                  console.error(
                    `[findAndRequestDrivers] Ride ${ride.id}: Transaction error for driver ${driver.driverId}:`,
                    txError
                  );
                  reject(
                    `[Driver: ${driver.driverId}] Transaction error for ride ${ride.id}: ${txError}`
                  );
                }
              } else {
                reject(
                  `[Driver: ${driver.driverId}] Rejected or did not respond affirmatively for ride ${ride.id}.`
                );
              }
            };

            individualTimeoutId = setTimeout(() => {
              io.off(eventName, responseListener);
              reject(
                `[Driver: ${driver.driverId}] Response timed out for ride ${ride.id}.`
              );
            }, DRIVER_INDIVIDUAL_RESPONSE_TIMEOUT_MS);

            driverIndividualTimeouts.push(individualTimeoutId);
            activeListeners.push({ eventName, listener: responseListener });
            io.once(eventName, responseListener);

            const rideStateBeforeEmit = await prisma.ride.findUnique({
              where: { id: ride.id },
              select: { status: true },
            });
            if (
              rideAccepted ||
              rideStateBeforeEmit?.status !== RideStatus.SEARCHING
            ) {
              clearTimeout(individualTimeoutId);
              io.off(eventName, responseListener);
              reject(
                `[Driver: ${driver.driverId}] Ride ${ride.id} status changed or accepted before emitting request.`
              );
              return;
            }

            const pickupMetrics = await calculatePickupMetrics(
              driver,
              ride.pickupLocation
            );
            console.log(
              `[findAndRequestDrivers] Ride ${ride.id}: Emitting ride_request to driver ${driver.driverId} (socket ${driver.socketId})`
            );
            io.to(driver.socketId!).emit("ride_request", {
              rideId: ride.id,
              pickupLocation: ride.pickupLocation,
              dropLocation: ride.dropLocation,
              pickupAddress: ride.pickupLocation,
              dropAddress: ride.dropLocation,
              fare: ride.fare,
              distance: ride.distance,
              duration: ride.duration,
              paymentMode: ride.paymentMode,
              carrierRequested: ride.carrierRequested,
              carCategory: ride.carCategory,
              carrierCharge: ride.carrierCharge,
              pickupDistance: pickupMetrics.pickupDistance,
              pickupDuration: pickupMetrics.pickupDuration,
              userId: ride.userId,
              userName: ride.user?.name,
              userPhone: ride.user?.phone,
            });

            // Send FCM notification alongside socket emission
            try {
              await sendRideRequestNotificationsToDrivers([driver.driverId], {
                rideId: ride.id,
                pickupLocation: ride.pickupLocation,
                dropLocation: ride.dropLocation,
                fare: `₹${ride.fare}`,
                distance: `${ride.distance || 0}km`,
                duration: `${ride.duration || 0}min`,
                carCategory: ride.carCategory || "CAR",
                carrierRequested: ride.carrierRequested,
                paymentMode:
                  ride.paymentMode === PaymentMode.CASH ? "CASH" : "ONLINE",
                userInfo: {
                  name: ride.user?.name,
                  phone: ride.user?.phone,
                },
              });
            } catch (fcmError) {
              console.error(
                `Failed to send FCM notification to driver ${driver.driverId}:`,
                fcmError
              );
            }
          });
        });

        Promise.race(acceptancePromises)
          .then(async (acceptedRideDetails) => {
            if (
              acceptedRideDetails &&
              rideAccepted &&
              winningRideDetails &&
              winningRideDetails.id === acceptedRideDetails.id
            ) {
              console.log(
                `[findAndRequestDrivers] Ride ${ride.id} definitively accepted by ${winningRideDetails.driverId}. Proceeding with notifications.`
              );

              io.to(winningRideDetails.userId).emit("ride_status_update", {
                rideId: ride.id,
                status: RideStatus.ACCEPTED,
                driverId: winningRideDetails.driverId,
                driver: {
                  id: winningRideDetails.driver.id,
                  name: winningRideDetails.driver.name,
                  phoneNumber: winningRideDetails.driver.phone,
                  rating:
                    winningRideDetails.driver.driverDetails?.rating ?? 4.5,
                  vehicleNumber:
                    winningRideDetails.driver.driverDetails?.vehicleNumber ??
                    "",
                  vehicleModel:
                    winningRideDetails.driver.driverDetails?.vehicleName ?? "",
                  image: winningRideDetails.driver.selfieUrl,
                  location: {
                    latitude: winningRideDetails.driver.locationLat ?? 0,
                    longitude: winningRideDetails.driver.locationLng ?? 0,
                  },
                  hasCarrier:
                    winningRideDetails.driver.driverDetails?.hasCarrier ??
                    false,
                },
                pickupDistance: winningRideDetails.pickupMetrics.pickupDistance,
                pickupDuration: winningRideDetails.pickupMetrics.pickupDuration,
                otp: winningRideDetails.otp,
              });

              // Send FCM notification to user that driver has been found - Fixed async call
              (async () => {
                try {
                  console.log(
                    `[FCM] Sending driver found notification to user ${winningRideDetails.userId}`
                  );
                  await sendNotificationToUser(
                    winningRideDetails.userId,
                    "🎉 Driver Found - Ride Confirmed!",
                    `${winningRideDetails.driver.name || "Your driver"} is now heading to your pickup location. Vehicle: ${winningRideDetails.driver.driverDetails?.vehicleNumber || "N/A"}. Get ready! 🚗✨`,
                    "booking_confirmed",
                    {
                      rideId: winningRideDetails.id,
                      driverName: winningRideDetails.driver.name || "Driver",
                      driverPhone: winningRideDetails.driver.phone || "",
                      vehicleNumber:
                        winningRideDetails.driver.driverDetails
                          ?.vehicleNumber || "",
                      status: "accepted",
                      otp: winningRideDetails.otp,
                      estimatedAmount: `₹${ride.fare}`,
                      pickupDistance: `${winningRideDetails.pickupMetrics.pickupDistance}km`,
                      pickupTime: `${winningRideDetails.pickupMetrics.pickupDuration}min`,
                    }
                  );
                  console.log(
                    `[FCM] Driver found notification sent successfully to user ${winningRideDetails.userId}`
                  );
                } catch (fcmError) {
                  console.error(
                    `[FCM] Failed to send ride accepted FCM notification to user ${winningRideDetails.userId}:`,
                    fcmError
                  );
                }
              })();

              io.to(winningRideDetails.driverId).emit(
                "ride_assignment_confirmed",
                {
                  rideId: ride.id,
                  message: "You have been assigned this ride.",
                  rideDetails: winningRideDetails,
                }
              );

              io.emit("ride_unavailable", {
                rideId: ride.id,
                acceptedByDriverId: winningRideDetails.driverId,
              });
            }
          })
          .catch((error) => {
            console.log(
              `[findAndRequestDrivers] Ride ${ride.id}: Batch for radius ${currentRadius}km: No acceptance or all rejected. Error (if any):`,
              error instanceof Error ? error.message : error
            );
          });
      }

      if (rideAccepted) break;

      const timeElapsedInIteration = Date.now() - iterationStartTime;
      let timeToWait = RADIUS_EXPANSION_INTERVAL_MS - timeElapsedInIteration;

      const remainingTimeOverall = searchDeadline - Date.now();
      timeToWait = Math.min(timeToWait, remainingTimeOverall);

      if (timeToWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }

      if (Date.now() >= searchDeadline || rideAccepted) {
        break;
      }

      currentRadius = Math.min(currentRadius + 2, MAX_SEARCH_RADIUS);

      if (
        currentRadius >= MAX_SEARCH_RADIUS &&
        Date.now() < searchDeadline &&
        !rideAccepted
      ) {
        const finalWaitTime = searchDeadline - Date.now();
        if (finalWaitTime > 0) {
          console.log(
            `[findAndRequestDrivers] Ride ${ride.id}: Max radius reached, waiting final ${finalWaitTime}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, finalWaitTime));
        }
        break;
      }
    }

    cleanupSystem();

    if (rideAccepted && winningRideDetails) {
      console.log(
        `[findAndRequestDrivers] Ride ${ride.id} search successful. Driver: ${winningRideDetails.driverId}`
      );
      return {
        success: true,
        message: "Driver found and ride accepted.",
        ride: winningRideDetails,
      };
    } else {
      console.log(
        `[findAndRequestDrivers] Ride ${ride.id} search ended. No driver accepted within time limit or ride cancelled.`
      );
      return {
        success: false,
        message: ride.carrierRequested
          ? "No drivers with carrier available within the time limit."
          : "No available drivers found within the time limit.",
      };
    }
  } catch (error) {
    console.error(
      `[findAndRequestDrivers] CRITICAL ERROR during search for ride ${ride.id}:`,
      error
    );
    cleanupSystem();
    return {
      success: false,
      message: "A critical error occurred during driver search.",
    };
  }
}

// Define types for the package structure
type PackageDetails = {
  km: number;
  price: number;
};

type PackageHours = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

type RentalPackages = {
  [K in CarCategory]: {
    [H in PackageHours]: PackageDetails;
  };
};

// Define the rental packages with proper typing
const RENTAL_PACKAGES: RentalPackages = {
  mini: {
    1: { km: 15, price: 380 },
    2: { km: 25, price: 550 },
    3: { km: 35, price: 700 },
    4: { km: 45, price: 950 },
    5: { km: 60, price: 1250 },
    6: { km: 70, price: 1550 },
    7: { km: 80, price: 1850 },
    8: { km: 90, price: 2100 },
  },
  sedan: {
    1: { km: 15, price: 450 },
    2: { km: 25, price: 600 },
    3: { km: 40, price: 850 },
    4: { km: 50, price: 1100 },
    5: { km: 65, price: 1400 },
    6: { km: 75, price: 1650 },
    7: { km: 85, price: 2000 },
    8: { km: 90, price: 2300 },
  },
  suv: {
    1: { km: 15, price: 580 },
    2: { km: 25, price: 750 },
    3: { km: 40, price: 950 },
    4: { km: 50, price: 1200 },
    5: { km: 65, price: 1500 },
    6: { km: 75, price: 1850 },
    7: { km: 85, price: 2100 },
    8: { km: 90, price: 2450 },
  },
};

const EXTRA_KM_RATES = {
  mini: 14,
  sedan: 16,
  suv: 18,
};

const EXTRA_MINUTE_RATE = 2;

// Add this new function to calculate rental fare
export const calculateRentalFare = (
  carCategory: string,
  packageHours: number,
  actualKms: number,
  actualMinutes: number
) => {
  const category = carCategory.toLowerCase() as keyof typeof RENTAL_PACKAGES;
  const packageDetails =
    RENTAL_PACKAGES[category][
      packageHours as keyof (typeof RENTAL_PACKAGES)[typeof category]
    ];

  if (!packageDetails) {
    throw new Error("Invalid package selected");
  }

  const basePrice = packageDetails.price;
  const packageKms = packageDetails.km;

  // Calculate extra km charges
  const extraKms = Math.max(0, actualKms - packageKms);
  const extraKmCharges = extraKms * EXTRA_KM_RATES[category];

  // Calculate extra minute charges
  const packageMinutes = packageHours * 60;
  const extraMinutes = Math.max(0, actualMinutes - packageMinutes);
  const extraMinuteCharges = extraMinutes * EXTRA_MINUTE_RATE;

  return {
    basePrice,
    packageKms,
    extraKmCharges,
    extraMinuteCharges,
    totalAmount: basePrice + extraKmCharges + extraMinuteCharges,
  };
};

// Type guards for validation
const isValidCarCategory = (category: string): category is CarCategory => {
  return ["mini", "sedan", "suv"].includes(category.toLowerCase());
};

const isValidPackageHours = (hours: number): hours is PackageHours => {
  return hours >= 1 && hours <= 8;
};

// Modify createRide to handle carrier requests for all ride types
export const createRide = async (req: Request, res: Response) => {
  // 1. Extract request body data
  const {
    pickupLocation,
    dropLocation, // May be empty for rentals
    carCategory,
    paymentMode,
    isCarRental, // Boolean indicating rental type
    rentalPackageHours, // Only relevant for rentals
    carrierRequested, // Boolean for carrier need
  } = req.body;

  // 2. Validate user authentication
  if (!req.user) {
    console.error("[createRide] Error: Unauthorized access attempt.");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const userId = req.user.userId;
  console.log(`[createRide] Received request from user: ${userId}`);

  try {
    // 3. Prepare common ride data
    console.log(`[createRide] Preparing ride data for user ${userId}`);
    let rideData: any = {
      userId,
      pickupLocation,
      carCategory,
      status: RideStatus.SEARCHING, // Initial status
      paymentMode: paymentMode || PaymentMode.CASH, // Default to CASH
      otp: generateOTP().toString(), // Generate OTP
      rideType: isCarRental ? RideType.CAR_RENTAL : RideType.LOCAL,
      carrierRequested: carrierRequested || false,
      carrierCharge: carrierRequested ? CARRIER_CHARGE : 0,
      waitingStartTime: null,
      waitingMinutes: 0,
      waitingCharges: 0,
      extraCharges: 0,
      totalAmount: 0, // Initialize totalAmount (will be calculated below)
    };

    // 4. Add specific data based on ride type (Rental vs Local)
    let calculatedBaseFare = 0; // To store fare

    if (isCarRental) {
      console.log(`[createRide] Processing CAR_RENTAL for user ${userId}`);
      // Validate rental-specific inputs
      const isValidCategoryFlag = isValidCarCategory(carCategory);
      const isValidHoursFlag = isValidPackageHours(rentalPackageHours);
      if (!isValidCategoryFlag) {
        console.error(`[createRide] Invalid car category: ${carCategory}`);
        return res.status(400).json({ error: "Invalid car category" });
      }
      if (!isValidHoursFlag) {
        console.error(
          `[createRide] Invalid package hours: ${rentalPackageHours}`
        );
        return res.status(400).json({ error: "Invalid package hours" });
      }
      // Get rental package details
      const packageDetails =
        RENTAL_PACKAGES[carCategory.toLowerCase() as CarCategory][
          rentalPackageHours
        ];
      const baseRentalPrice =
        packageDetails.price + (rideData.carrierCharge || 0);
      calculatedBaseFare = baseRentalPrice; // Store base rental price

      rideData = {
        ...rideData,
        isCarRental: true,
        rentalPackageHours,
        rentalPackageKms: packageDetails.km,
        rentalBasePrice: baseRentalPrice,
        fare: baseRentalPrice, // Initial fare is base price
        totalAmount: baseRentalPrice, // Set total amount directly
        dropLocation: "", // Default empty drop location for rentals
        actualKmsTravelled: 0, // Initialize rental specific fields
        actualMinutes: 0,
        extraKmCharges: 0,
        extraMinuteCharges: 0,
      };
      console.log(`[createRide] Rental data prepared:`, rideData);
    } else {
      // Regular Local Ride
      console.log(`[createRide] Processing LOCAL ride for user ${userId}`);
      if (!dropLocation) {
        console.error(
          `[createRide] Error: Drop location is required for local rides.`
        );
        return res
          .status(400)
          .json({ error: "Drop location is required for local rides" });
      }
      // Calculate distance, duration, and fare
      rideData.dropLocation = dropLocation;
      console.log(
        `[createRide] Calculating distance/duration for ${pickupLocation} to ${dropLocation}`
      );
      const distance = await calculateDistance(pickupLocation, dropLocation);
      const duration = await calculateDuration(pickupLocation, dropLocation);
      console.log(
        `[createRide] Calculated Distance: ${distance} km, Duration: ${duration} min`
      );
      console.log(
        `[createRide] Calculating fare for category ${carCategory}, carrier: ${carrierRequested}`
      );
      const fareDetails = await calculateFare(
        pickupLocation,
        dropLocation,
        distance,
        carCategory,
        carrierRequested
      );
      calculatedBaseFare = fareDetails.totalFare; // Store calculated fare

      rideData = {
        ...rideData,
        distance,
        duration,
        fare: fareDetails.totalFare,
        totalAmount: fareDetails.totalFare, // Set total amount directly
        dropLocation: dropLocation, // Add drop location back
      };
      console.log(`[createRide] Local ride data prepared:`, rideData);
    }

    // 5. Create the Ride record (Removed fee reset logic)
    console.log(`[createRide] Creating ride record in database...`); // Simplified log

    // --- START: Simplified Ride Creation (Removed Transaction for Fee Reset) ---
    const ride = await prisma.ride.create({
      data: rideData, // Use the prepared rideData
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            // outstandingCancellationFee: true, // REMOVED - No longer needed here
          },
        },
        driver: {
          select: { id: true, name: true, phone: true, driverDetails: true },
        },
      },
    });
    // --- END: Simplified Ride Creation ---

    console.log(
      `[createRide] Ride record created successfully with ID: ${ride.id}. Final Total Amount: ${ride.totalAmount}`
    ); // Simplified log

    // 6. Respond IMMEDIATELY
    console.log(
      `[createRide] Sending immediate response (201) for ride ${ride.id}`
    );
    res.status(201).json({
      // message: feeAppliedToRide // REMOVED conditional message
      //   ? `Ride created, outstanding fee of ${outstandingFee} applied. Searching for driver...` // REMOVED
      //   : "Ride created, searching for driver...", // REMOVED
      message: "Ride created, searching for driver...", // SIMPLIFIED message
      ride: ride, // Send the full created ride object back
      // outstandingFeeApplied: feeAppliedToRide ? outstandingFee : 0, // REMOVED
    });
    console.log(
      `[createRide] Response sent for ride ${ride.id}. Initiating async driver search...`
    );

    // 7. Initiate driver search asynchronously (IIFE)
    (async () => {
      try {
        console.log(
          `[Async Search] Starting background driver search for ride ${ride.id}`
        );
        // Pass the newly created ride object with includes to the search function
        const driverSearchResult = await findAndRequestDrivers(ride); // This function searches and handles acceptance/socket emits
        console.log(
          `[Async Search] Background search completed for ride ${ride.id}. Result Success: ${driverSearchResult.success}, Message: ${driverSearchResult.message}`
        );

        // If the async search fails to find a driver
        if (!driverSearchResult.success) {
          console.log(
            `[Async Search] Driver search failed for ride ${ride.id}. Checking current status before potentially cancelling...`
          );
          // Check the ride status again before updating
          const currentRideState = await prisma.ride.findUnique({
            where: { id: ride.id },
            select: { status: true },
          });

          // Only update to CANCELLED if it's still in SEARCHING state
          if (currentRideState?.status === RideStatus.SEARCHING) {
            console.log(
              `[Async Search] Ride ${ride.id} still SEARCHING. Updating status to CANCELLED (No drivers found).`
            );
            // Update the database first
            await updateRideInDatabase(ride.id, RideStatus.CANCELLED);
            // Notify the user via socket AFTER db update
            io.to(ride.userId).emit("ride_status_update", {
              rideId: ride.id,
              status: RideStatus.CANCELLED,
              reason:
                driverSearchResult.message || "No available drivers found",
            });
            console.log(
              `[Async Search] Sent CANCELLED status update to user ${ride.userId} for ride ${ride.id}`
            );
          } else {
            console.log(
              `[Async Search] Ride ${ride.id} status is already ${currentRideState?.status}. No cancellation needed from async search failure.`
            );
          }
        }
        // If driverSearchResult.success is true, findAndRequestDrivers handles DB updates and socket emits.
      } catch (searchError) {
        console.error(
          `[Async Search] Error during background driver search for ride ${ride.id}:`,
          searchError
        );
        // Attempt to cancel the ride if an error occurred, checking status first
        try {
          const currentRideStateOnError = await prisma.ride.findUnique({
            where: { id: ride.id },
            select: { status: true },
          });
          if (currentRideStateOnError?.status === RideStatus.SEARCHING) {
            console.log(
              `[Async Search] Error occurred for ${ride.id} while SEARCHING. Updating status to CANCELLED.`
            );
            await updateRideInDatabase(ride.id, RideStatus.CANCELLED); // Update DB first
            io.to(ride.userId).emit("ride_status_update", {
              // Notify user after DB update
              rideId: ride.id,
              status: RideStatus.CANCELLED,
              reason: "Error during driver search process",
            });
            console.log(
              `[Async Search] Sent CANCELLED status update due to error to user ${ride.userId} for ride ${ride.id}`
            );
          } else {
            console.log(
              `[Async Search] Error occurred for ${ride.id}, but status is already ${currentRideStateOnError?.status}. No cancellation needed.`
            );
          }
        } catch (dbError) {
          console.error(
            `[Async Search] Error updating ride ${ride.id} to CANCELLED after search error:`,
            dbError
          );
        }
      }
    })(); // End of async IIFE
  } catch (error) {
    console.error(
      "[createRide] Error during initial ride creation process:",
      error
    );
    // Ensure response is sent only once
    if (!res.headersSent) {
      console.error(
        "[createRide] Sending 500 error response as headers were not sent."
      );
      res.status(500).json({ error: "Failed to create ride record" });
    } else {
      console.error(
        "[createRide] Error occurred after response was already sent. Ride ID potentially unknown or not created."
      );
    }
  }
};

//  updateRideStatus with wait timer and extra charges
export const updateRideStatus = async (req: Request, res: Response) => {
  const rideId = req.params.id;
  const { status, otp, cancellationReason } = req.body;
  const userId = req.user?.userId;
  const userType = req.user?.userType as UserType;

  try {
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { driver: true },
    });

    if (!ride) return res.status(404).json({ error: "Ride not found" });

    // Permission validation
    if (!validatePermissions(userType, userId, ride, status)) {
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
        return handleRideCancellation(
          ride.id,
          userId!,
          userType,
          cancellationReason,
          res
        );
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
  newStatus: RideStatus
): boolean => {
  if (!userType || !userId) return false;

  // Allow ride cancellation for both drivers and users
  if (newStatus === RideStatus.CANCELLED) {
    if (userType === "DRIVER") {
      return ride.driverId === userId;
    }
    if (userType === "USER") {
      return ride.userId === userId;
    }
    return false;
  }

  // Other status updates for drivers
  if (userType === "DRIVER") {
    return (
      ride.driverId === userId &&
      ["DRIVER_ARRIVED", "RIDE_STARTED", "RIDE_ENDED"].includes(newStatus)
    );
  }

  // For users, allow other actions if needed
  if (userType === "USER") {
    return ride.userId === userId;
  }

  return false;
};

const handleDriverArrival = async (ride: any) => {
  const updatedRide = await prisma.ride.update({
    where: { id: ride.id },
    data: {
      driverArrivedAt: new Date(),
      waitingStartTime: new Date(),
    },
    include: {
      driver: {
        select: { name: true, phone: true },
      },
    },
  });

  // Send FCM notification to user that driver has arrived
  try {
    await sendNotificationToUser(
      ride.userId,
      "🎯 Driver Arrived - Time to Go!",
      `${updatedRide.driver?.name || "Your driver"} is waiting at your pickup location! Share your OTP: ${ride.otp} to start your journey! 🚗🔑`,
      "driver_arrived",
      {
        rideId: ride.id,
        driverName: updatedRide.driver?.name || "Driver",
        driverPhone: updatedRide.driver?.phone || "",
        otp: ride.otp || "",
        status: "driver_arrived",
        urgentAction: "true",
        showOtpProminent: "true",
      }
    );
  } catch (fcmError) {
    console.error(
      `Failed to send driver arrived FCM notification to user ${ride.userId}:`,
      fcmError
    );
  }
};

const calculateWaitingCharges = async (ride: any) => {
  if (ride.waitingStartTime) {
    const now = new Date();
    const waitingTimeMs =
      now.getTime() - new Date(ride.waitingStartTime).getTime();
    const waitingMinutes = Math.floor(waitingTimeMs / (1000 * 60));

    // Only charge for waiting time beyond the free period
    const chargableMinutes = Math.max(0, waitingMinutes - FREE_WAITING_MINUTES);
    const waitingCharges = chargableMinutes * WAITING_CHARGE_PER_MINUTE;

    const updatedRide = await prisma.ride.update({
      where: { id: ride.id },
      data: {
        waitingMinutes,
        waitingCharges,
        fare: ride.fare + waitingCharges, // Add waiting charges to the fare
      },
      include: {
        driver: {
          select: { name: true, phone: true },
        },
      },
    });

    // Send FCM notification to user that ride has started
    try {
      await sendNotificationToUser(
        ride.userId,
        "🎊 Journey Started!",
        `Your ride with ${updatedRide.driver?.name || "your driver"} has started! Enjoy your journey to ${ride.dropLocation}! 🛣️✨`,
        "ride_started",
        {
          rideId: ride.id,
          driverName: updatedRide.driver?.name || "Driver",
          status: "ride_started",
          dropLocation: ride.dropLocation || "",
          estimatedAmount: `₹${ride.fare + waitingCharges}`,
          showJourneyTracker: "true",
          enableLiveTracking: "true",
        }
      );
    } catch (fcmError) {
      console.error(
        `Failed to send ride started FCM notification to user ${ride.userId}:`,
        fcmError
      );
    }

    return { waitingMinutes, chargableMinutes, waitingCharges };
  }
  return { waitingMinutes: 0, chargableMinutes: 0, waitingCharges: 0 };
};

export const handleRideCompletion = async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const { finalLocation, actualKmsTravelled, actualMinutes } = req.body;

  try {
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        status: RideStatus.RIDE_STARTED,
      },
      include: {
        user: true,
        driver: true,
      },
    });

    if (!ride) {
      return res
        .status(404)
        .json({ error: "Ride not found or invalid status" });
    }

    let finalAmount: number;
    let updateData: any = {
      status:
        ride.paymentMode === PaymentMode.CASH
          ? RideStatus.RIDE_ENDED
          : RideStatus.PAYMENT_PENDING,
      dropLocation: finalLocation,
    };

    let fareBreakdown: any = {};

    if (ride.isCarRental) {
      // Calculate final amount for rental
      const rentalCalculation = calculateRentalFare(
        ride.carCategory!,
        ride.rentalPackageHours!,
        actualKmsTravelled,
        actualMinutes
      );

      updateData = {
        ...updateData,
        actualKmsTravelled,
        actualMinutes,
        extraKmCharges: rentalCalculation.extraKmCharges,
        extraMinuteCharges: rentalCalculation.extraMinuteCharges,
        totalAmount: rentalCalculation.totalAmount + (ride.carrierCharge || 0),
      };

      finalAmount = updateData.totalAmount;

      // Create rental-specific fare breakdown
      fareBreakdown = {
        basePrice: rentalCalculation.basePrice,
        packageKms: rentalCalculation.packageKms,
        extraKmCharges: rentalCalculation.extraKmCharges,
        extraMinuteCharges: rentalCalculation.extraMinuteCharges,
        carrierCharge: ride.carrierRequested ? ride.carrierCharge || 0 : 0,
        totalAmount: finalAmount,
      };
    } else {
      // Include waiting charges in final amount
      finalAmount = calculateFinalAmount(ride);

      // Make sure waiting charges are included in totalAmount
      updateData.totalAmount = finalAmount;

      // Create standard ride fare breakdown
      fareBreakdown = {
        baseFare: ride.fare || 0,
        waitingCharges: ride.waitingCharges || 0,
        carrierCharge: ride.carrierRequested ? ride.carrierCharge || 0 : 0,
        extraCharges: ride.extraCharges || 0,
        totalAmount: finalAmount,
      };
    }

    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: updateData,
      include: {
        user: true,
        driver: true,
      },
    });

    // Emit ride completion event with detailed fare breakdown
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      finalLocation,
      amount: finalAmount,
      paymentMode: ride.paymentMode,
      fareBreakdown: fareBreakdown,
      distance: ride.distance || 0,
      duration: ride.duration || 0,
      isCarRental: ride.isCarRental,
      carrierRequested: ride.carrierRequested,
      carrierCharge: ride.carrierCharge,
      waitingCharges: ride.waitingCharges || 0,
      waitingMinutes: ride.waitingMinutes || 0,
      ...(ride.isCarRental && {
        actualKmsTravelled,
        actualMinutes,
        extraKmCharges: updateData.extraKmCharges,
        extraMinuteCharges: updateData.extraMinuteCharges,
      }),
    });

    // Handle payment based on mode
    if (ride.paymentMode === PaymentMode.CASH) {
      return res.json({
        success: true,
        message: "Ride completed, awaiting cash collection",
        ride: updatedRide,
        fareBreakdown: fareBreakdown,
      });
    } else {
      const paymentDetails = await initiateRazorpayPayment(updatedRide);
      return res.json({
        success: true,
        message: "Payment initiated",
        ride: updatedRide,
        paymentDetails,
        fareBreakdown: fareBreakdown,
      });
    }
  } catch (error) {
    console.error("Error completing ride:", error);
    return res.status(500).json({
      error: "Failed to complete ride",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
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

    // Calculate waiting time details if driver has arrived
    let waitingTimeDetails = null;
    if (ride.status === RideStatus.DRIVER_ARRIVED && ride.waitingStartTime) {
      const now = new Date();
      const waitingTimeMs =
        now.getTime() - new Date(ride.waitingStartTime).getTime();
      const waitingMinutes = Math.floor(waitingTimeMs / (1000 * 60));
      const chargableMinutes = Math.max(
        0,
        waitingMinutes - FREE_WAITING_MINUTES
      );

      waitingTimeDetails = {
        waitingStartTime: ride.waitingStartTime,
        currentWaitingMinutes: waitingMinutes,
        freeWaitingMinutes: FREE_WAITING_MINUTES,
        chargableMinutes: chargableMinutes,
        currentWaitingCharges: chargableMinutes * WAITING_CHARGE_PER_MINUTE,
        chargePerMinute: WAITING_CHARGE_PER_MINUTE,
      };
    }

    res.json({ ride, driverStatus, waitingTimeDetails });
  } catch (error) {
    console.error("Error fetching ride details:", error);
    res.status(500).json({ error: "Failed to retrieve ride details" });
  }
};

const CANCELLATION_FEE_AMOUNT = 25; // Define the fee amount

/**
 * Helper function to send ride request notifications to multiple drivers
 */
async function sendRideRequestNotificationsToDrivers(
  driverIds: string[],
  rideData: {
    rideId: string;
    pickupLocation: string;
    dropLocation: string;
    fare: string;
    distance?: string;
    duration?: string;
    carCategory: string;
    carrierRequested?: boolean;
    paymentMode?: string;
    userInfo?: {
      name?: string;
      phone?: string;
    };
  }
): Promise<void> {
  try {
    console.log(`🔍 Looking for FCM tokens for driver IDs:`, driverIds);

    // Fetch drivers' FCM tokens from database
    const drivers = await prisma.user.findMany({
      where: {
        id: { in: driverIds },
        fcmToken: { not: null },
      },
      select: { id: true, fcmToken: true, name: true },
    });

    console.log(
      `📋 Found ${drivers.length} drivers with FCM tokens out of ${driverIds.length} total drivers`
    );
    console.log(
      `📱 Drivers with tokens:`,
      drivers.map((d) => ({ id: d.id, name: d.name, hasToken: !!d.fcmToken }))
    );

    if (drivers.length === 0) {
      console.warn(
        `⚠️ No drivers found with valid FCM tokens for ride ${rideData.rideId}`
      );
      return;
    }

    console.log(
      `📤 Sending ride request notifications to ${drivers.length} drivers for ride ${rideData.rideId}`
    );

    // Send notifications to all drivers with valid FCM tokens
    const notificationPromises = drivers.map(async (driver) => {
      if (!driver.fcmToken || !validateFcmToken(driver.fcmToken)) {
        console.warn(`❌ Invalid FCM token for driver ${driver.id}`);
        return;
      }

      try {
        const notificationData = {
          bookingId: rideData.rideId,
          amount: rideData.fare,
          pickupLocation: rideData.pickupLocation,
          dropLocation: rideData.dropLocation,
          distance: rideData.distance || "Calculating...",
          duration: rideData.duration || "Calculating...",
          rideType: rideData.carCategory.toUpperCase(),
          carrierRequested: rideData.carrierRequested,
          paymentType: rideData.paymentMode || "CASH",
          passengerName: rideData.userInfo?.name || "Customer",
          passengerPhone: rideData.userInfo?.phone || "",
        };

        await sendTaxiSureBookingNotification(
          driver.fcmToken,
          notificationData
        );

        console.log(
          `✅ Ride request notification sent to driver ${driver.name || driver.id}`
        );
      } catch (error) {
        console.error(
          `❌ Failed to send notification to driver ${driver.id}:`,
          error
        );
      }
    });

    await Promise.allSettled(notificationPromises);
  } catch (error) {
    console.error(
      "❌ Error sending ride request notifications to drivers:",
      error
    );
  }
}

/**
 * Helper function to send notification to a specific user
 */
async function sendNotificationToUser(
  userId: string,
  title: string,
  body: string,
  notificationType:
    | "general"
    | "booking_confirmed"
    | "driver_arrived"
    | "ride_started"
    | "payment_success"
    | "promotion"
    | "rating_request",
  additionalData?: Record<string, string>
): Promise<void> {
  try {
    console.log(
      `[FCM-Cancellation] 📤 Starting notification process for user ${userId}`
    );
    console.log(`[FCM-Cancellation] 📋 Title: "${title}"`);
    console.log(`[FCM-Cancellation] 📝 Body: "${body}"`);
    console.log(`[FCM-Cancellation] 🏷️ Type: ${notificationType}`);
    console.log(
      `[FCM-Cancellation] 📦 Additional data:`,
      additionalData || "None"
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true, name: true, userType: true },
    });

    console.log(
      `[FCM-Cancellation] 🔍 Database query result - User: ${user?.name || "Unknown"} (${user?.userType}), Has FCM token: ${!!user?.fcmToken}`
    );

    if (!user) {
      console.error(
        `[FCM-Cancellation] ❌ User not found in database: ${userId}`
      );
      return;
    }

    if (!user.fcmToken) {
      console.warn(
        `[FCM-Cancellation] ❌ No FCM token found for user ${userId} (${user.name})`
      );
      return;
    }

    console.log(
      `[FCM-Cancellation] 🔐 FCM token preview: ${user.fcmToken.substring(0, 30)}...`
    );

    if (!validateFcmToken(user.fcmToken)) {
      console.warn(
        `[FCM-Cancellation] ❌ Invalid FCM token format for user ${userId} (${user.name})`
      );
      return;
    }

    console.log(
      `[FCM-Cancellation] ✅ Token validation passed for ${user.name}`
    );
    console.log(
      `[FCM-Cancellation] 📤 Calling sendTaxiSureRegularNotification...`
    );

    await sendTaxiSureRegularNotification(
      user.fcmToken,
      title,
      body,
      notificationType,
      additionalData
    );

    console.log(
      `[FCM-Cancellation] ✅ Notification sent successfully to user ${user.name || userId}: ${title}`
    );
  } catch (error) {
    console.error(
      `[FCM-Cancellation] ❌ Error in sendNotificationToUser for ${userId}:`,
      error
    );
    if (error instanceof Error) {
      console.error(`[FCM-Cancellation] ❌ Error name: ${error.name}`);
      console.error(`[FCM-Cancellation] ❌ Error message: ${error.message}`);
      console.error(`[FCM-Cancellation] ❌ Error stack: ${error.stack}`);
    }
    throw error; // Re-throw to be caught by the caller
  }
}

// Modify handleRideCancellation to accept rideId and cancellingUserId
const handleRideCancellation = async (
  rideId: string,
  cancellingUserId: string, // ID of the user/driver initiating the cancellation
  cancellingUserType: UserType, // Type of the user cancelling
  cancellationReason: string,
  res: Response // Pass response object to send result
) => {
  try {
    // 1. Fetch the current ride details FIRST
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: {
        // Select necessary fields
        id: true,
        status: true,
        driverArrivedAt: true, // Key field to check for fee
        userId: true,
        driverId: true,
        paymentMode: true, // Needed potentially for other logic
        totalAmount: true, // Needed if we modify it directly (less likely now)
      },
    });

    if (!ride) {
      console.error(`[handleRideCancellation] Ride not found: ${rideId}`);
      return res.status(404).json({ error: "Ride not found" });
    }

    // Prevent cancellation if ride is already completed or cancelled
    if (
      [
        RideStatus.RIDE_ENDED,
        RideStatus.PAYMENT_COMPLETED,
        RideStatus.CANCELLED,
      ].some((s) => s === ride.status) // Use .some() for type safety
    ) {
      console.log(
        `[handleRideCancellation] Ride ${rideId} already finished or cancelled. Status: ${ride.status}`
      );
      return res
        .status(400)
        .json({ error: "Ride cannot be cancelled in its current state" });
    }

    const initialRideStatus = ride.status; // Capture status before any updates

    console.log(
      `[handleRideCancellation] Processing cancellation for ride ${ride.id} by ${cancellingUserType} (${cancellingUserId}). Reason: ${cancellationReason}`
    );

    // 2. Determine if cancellation fee applies (Driver has arrived)
    const feeApplies = ride.driverArrivedAt !== null;
    let cancellationFee = feeApplies ? CANCELLATION_FEE_AMOUNT : 0;
    let feeMessage = feeApplies
      ? `Cancellation fee of ${cancellationFee} INR applied.`
      : "No cancellation fee applied.";

    console.log(
      `[handleRideCancellation] Driver arrived: ${!!ride.driverArrivedAt}. Fee applies: ${feeApplies}. Fee amount: ${cancellationFee}`
    );

    let updatedRideData: any;
    let responsePayload: any = {
      success: true,
      message: `Ride cancelled successfully. ${feeMessage}`,
      cancellationFee,
      cancelledBy: cancellingUserType,
    };

    // 3. Apply cancellation logic based on who cancelled and if fee applies
    if (cancellingUserType === UserType.USER) {
      console.log(
        `[handleRideCancellation] User cancellation for ride ${ride.id}.`
      );
      if (feeApplies) {
        // User cancels after driver arrived - Deduct fee from user's wallet
        console.log(
          `[handleRideCancellation] Fee applies. Deducting from user ${ride.userId}'s wallet.`
        );
        try {
          // --- Start: Transaction for User Fee Deduction ---
          const transactionResult = await prisma.$transaction(async (tx) => {
            // 1. Deduct from user wallet
            const wallet = await tx.wallet.update({
              where: { userId: ride.userId }, // Use user ID
              data: {
                balance: {
                  decrement: cancellationFee, // Deduct the fee
                },
              },
            });
            console.log(
              `[handleRideCancellation] User ${ride.userId}'s wallet updated. New balance: ${wallet.balance}`
            );

            // 2. Create Transaction record using existing type
            await tx.transaction.create({
              data: {
                amount: cancellationFee,
                currency: "INR",
                type: TransactionType.USER_CANCELLATION_FEE_APPLIED,
                status: TransactionStatus.COMPLETED,
                senderId: ride.userId, // User is the 'sender' of the fee
                receiverId: null, // Or system/admin ID
                rideId: ride.id,
                description: `Cancellation fee (user) deducted from wallet for ride ${ride.id}`,
              },
            });
            console.log(
              `[handleRideCancellation] User cancellation fee transaction created (using USER_CANCELLATION_FEE_APPLIED type) for ride ${ride.id}.`
            );

            // 3. Update Ride status
            const updatedRide = await tx.ride.update({
              where: { id: ride.id },
              data: {
                status: RideStatus.CANCELLED,
                cancellationReason,
                cancellationFee, // Record the fee on the ride itself
                cancelledBy: CancelledBy.USER,
                driverId: null, // Ensure driver is unassigned
              },
              include: { user: true, driver: true }, // Include relations for notification
            });
            return updatedRide; // Return the updated ride from the transaction
          });
          // --- End: Transaction ---

          updatedRideData = transactionResult; // Assign the result from the transaction
          responsePayload.ride = updatedRideData;
          responsePayload.message = `Ride cancelled. A fee of ${cancellationFee} INR has been deducted from your wallet.`; // Update message
          console.log(
            `[handleRideCancellation] User ${ride.userId} fee deducted from wallet.`
          );
        } catch (error) {
          console.error(
            `[handleRideCancellation] Error processing user fee transaction for ride ${ride.id}:`,
            error
          );
          return res.status(500).json({
            error:
              "Failed to process cancellation fee deduction. Ride not cancelled.",
          });
        }
      } else {
        // User cancels before driver arrives - No fee
        // Preserve driverId for notification, but mark ride as cancelled
        updatedRideData = await prisma.ride.update({
          where: { id: ride.id },
          data: {
            status: RideStatus.CANCELLED,
            cancellationReason,
            cancellationFee: 0, // Explicitly 0 fee
            cancelledBy: CancelledBy.USER,
            // Keep driverId for FCM notification purposes - don't set to null
          },
          include: { user: true, driver: true }, // Include relations for notification
        });
        responsePayload.ride = updatedRideData;
      }
    } else if (cancellingUserType === UserType.DRIVER) {
      console.log(
        `[handleRideCancellation] Driver cancellation for ride ${ride.id}.`
      );
      if (feeApplies) {
        // Driver cancels after arriving - Deduct fee from driver's wallet
        console.log(
          `[handleRideCancellation] Fee applies. Deducting from driver ${ride.driverId}'s wallet.`
        );
        if (!ride.driverId) {
          console.error(
            `[handleRideCancellation] Critical error: Fee applies but driverId is null for ride ${ride.id}`
          );
          // Handle this unlikely case - maybe just cancel without fee deduction?
          return res.status(500).json({
            error:
              "Internal server error: Cannot apply driver fee without driver ID.",
          });
        }
        try {
          const transactionResult = await prisma.$transaction(async (tx) => {
            // 1. Deduct from wallet
            const wallet = await tx.wallet.update({
              where: { userId: ride.driverId! },
              data: {
                balance: {
                  decrement: cancellationFee,
                },
              },
            });
            console.log(
              `[handleRideCancellation] Driver ${ride.driverId}'s wallet updated. New balance: ${wallet.balance}`
            );

            // 2. Create Transaction record
            await tx.transaction.create({
              data: {
                amount: cancellationFee,
                currency: "INR",
                type: TransactionType.DRIVER_CANCELLATION_FEE, // Use specific type
                status: TransactionStatus.COMPLETED,
                senderId: ride.driverId, // Driver is the 'sender' of the fee
                receiverId: null, // Or a system/admin ID if you have one
                rideId: ride.id,
                description: `Cancellation fee (driver) for ride ${ride.id}`,
              },
            });
            console.log(
              `[handleRideCancellation] Driver cancellation fee transaction created for ride ${ride.id}.`
            );

            // 3. Update Ride status
            const updatedRide = await tx.ride.update({
              where: { id: ride.id },
              data: {
                status: RideStatus.CANCELLED,
                cancellationReason,
                cancellationFee,
                cancelledBy: CancelledBy.DRIVER, // Use the enum
              },
              include: { user: true, driver: true },
            });
            return updatedRide; // Return the updated ride from the transaction
          });
          updatedRideData = transactionResult; // Assign the result from the transaction
          responsePayload.ride = updatedRideData;
          responsePayload.message = `Ride cancelled. A fee of ${cancellationFee} INR has been deducted from your wallet.`;
        } catch (error) {
          console.error(
            `[handleRideCancellation] Error processing driver fee transaction for ride ${ride.id}:`,
            error
          );
          // Don't cancel the ride if the transaction fails? Or cancel without fee? Decide policy.
          // For now, respond with error and don't cancel.
          return res.status(500).json({
            error:
              "Failed to process cancellation fee deduction. Ride not cancelled.",
          });
        }
      } else {
        // Driver cancels before arriving - No fee
        updatedRideData = await prisma.ride.update({
          where: { id: ride.id },
          data: {
            status: RideStatus.CANCELLED,
            cancellationReason,
            cancellationFee: 0, // Explicitly set fee to 0
            cancelledBy: CancelledBy.DRIVER,
          },
          include: { user: true, driver: true },
        });
        responsePayload.ride = updatedRideData;
      }
    } else {
      console.error(
        `[handleRideCancellation] Invalid user type for cancellation: ${cancellingUserType}`
      );
      return res
        .status(400)
        .json({ error: "Invalid user type initiating cancellation." });
    }

    // 4. Emit socket events AFTER database updates are successful
    if (updatedRideData) {
      console.log(
        `[handleRideCancellation] Emitting cancellation updates for ride ${ride.id}.`
      );

      // If a user cancelled a ride that was actively being searched for
      if (
        cancellingUserType === UserType.USER &&
        initialRideStatus === RideStatus.SEARCHING
      ) {
        console.log(
          `[handleRideCancellation] User cancelled ride ${ride.id} while it was SEARCHING. Notifying drivers.`
        );
        io.emit("ride_unavailable", {
          rideId: ride.id,
          reason: "cancelled_by_user",
          message: "The ride request has been cancelled by the user.",
        });
      }

      // Notify the other party (if they exist)
      const targetUserId =
        cancellingUserType === UserType.USER
          ? updatedRideData.driverId
          : updatedRideData.userId;
      const targetDriverId =
        cancellingUserType === UserType.DRIVER
          ? updatedRideData.userId
          : updatedRideData.driverId;

      if (updatedRideData.userId) {
        io.to(updatedRideData.userId).emit("ride_status_update", {
          rideId: ride.id,
          status: RideStatus.CANCELLED,
          reason: cancellationReason,
          cancelledBy: cancellingUserType,
          cancellationFee: cancellationFee, // Send fee info
          feeDeducted: cancellingUserType === UserType.USER && feeApplies, // Indicate if fee was deducted from user wallet
        });
      }
      if (updatedRideData.driverId) {
        io.to(updatedRideData.driverId).emit("ride_status_update", {
          rideId: ride.id,
          status: RideStatus.CANCELLED,
          reason: cancellationReason,
          cancelledBy: cancellingUserType,
          cancellationFee: cancellationFee, // Send fee info
          feeDeducted: cancellingUserType === UserType.DRIVER && feeApplies, // Existing - Indicate if fee was deducted from driver wallet
        });
      }

      // Send FCM notifications for cancellation with enhanced logging
      console.log(
        `[handleRideCancellation] Starting FCM notification process for ride ${ride.id}`
      );
      console.log(
        `[handleRideCancellation] Cancelled by: ${cancellingUserType}, Driver ID: ${updatedRideData.driverId}, User ID: ${updatedRideData.userId}`
      );
      console.log(
        `[handleRideCancellation] Updated ride data includes - User: ${!!updatedRideData.user}, Driver: ${!!updatedRideData.driver}`
      );

      try {
        const cancelledByUser = cancellingUserType === UserType.USER;
        const cancelledByDriver = cancellingUserType === UserType.DRIVER;

        console.log(
          `[handleRideCancellation] FCM condition check - CancelledByUser: ${cancelledByUser}, DriverId exists: ${!!updatedRideData.driverId}, CancelledByDriver: ${cancelledByDriver}`
        );

        if (cancelledByUser && updatedRideData.driverId) {
          console.log(
            `[handleRideCancellation] User cancelled - sending FCM notification to driver ${updatedRideData.driverId}`
          );
          // User cancelled - notify driver using dedicated cancellation function
          const driverUser = await prisma.user.findUnique({
            where: { id: updatedRideData.driverId },
            select: { fcmToken: true, name: true, userType: true },
          });

          if (driverUser?.fcmToken && validateFcmToken(driverUser.fcmToken)) {
            await sendTaxiSureCancellationNotification(
              driverUser.fcmToken,
              "🚫 Ride Cancelled by Customer",
              `The ride has been cancelled by ${updatedRideData.user?.name || "the customer"}.${cancellationReason ? ` Reason: ${cancellationReason}` : ""}${feeApplies ? ` A cancellation fee of ₹${cancellationFee} has been applied.` : ""} You can now accept new rides.`,
              {
                rideId: updatedRideData.id,
                cancelledBy: "user",
                reason: cancellationReason || "",
                cancellationFee: cancellationFee.toString(),
                feeApplied: feeApplies.toString(),
                customerName: updatedRideData.user?.name || "Customer",
                showBackToOnline: "true",
                allowNewBookings: "true",
              }
            );
            console.log(
              `[handleRideCancellation] FCM cancellation notification sent successfully to driver ${updatedRideData.driverId}`
            );
          } else {
            console.warn(
              `[handleRideCancellation] Driver ${updatedRideData.driverId} has no valid FCM token for cancellation notification`
            );
          }
        } else if (cancelledByDriver) {
          console.log(
            `[handleRideCancellation] Driver cancelled - sending FCM notification to user ${updatedRideData.userId}`
          );
          // Driver cancelled - notify user using dedicated cancellation function
          const user = await prisma.user.findUnique({
            where: { id: updatedRideData.userId },
            select: { fcmToken: true, name: true, userType: true },
          });

          if (user?.fcmToken && validateFcmToken(user.fcmToken)) {
            await sendTaxiSureCancellationNotification(
              user.fcmToken,
              "🚫 Ride Cancelled by Driver",
              `Your ride has been cancelled by ${updatedRideData.driver?.name || "the driver"}.${cancellationReason ? ` Reason: ${cancellationReason}` : ""}${feeApplies ? ` A cancellation fee of ₹${cancellationFee} may apply.` : ""} We'll help you find another driver.`,
              {
                rideId: updatedRideData.id,
                cancelledBy: "driver",
                reason: cancellationReason || "",
                cancellationFee: cancellationFee.toString(),
                feeApplied: feeApplies.toString(),
                driverName: updatedRideData.driver?.name || "Driver",
                showRebookOption: "true",
                findNewDriver: "true",
              }
            );
            console.log(
              `[handleRideCancellation] FCM cancellation notification sent successfully to user ${updatedRideData.userId}`
            );
          } else {
            console.warn(
              `[handleRideCancellation] User ${updatedRideData.userId} has no valid FCM token for cancellation notification`
            );
          }
        } else {
          console.log(
            `[handleRideCancellation] No FCM notification needed. CancelledByUser: ${cancelledByUser}, DriverId: ${updatedRideData.driverId}, CancelledByDriver: ${cancelledByDriver}`
          );
        }
      } catch (notificationError) {
        console.error(
          `[handleRideCancellation] Failed to send cancellation FCM notification for ride ${ride.id}:`,
          notificationError
        );
        // Don't fail the cancellation due to notification error
      }

      console.log(
        `[handleRideCancellation] FCM notification process completed for ride ${ride.id}`
      );

      // Broadcast generic cancellation (optional, maybe remove if specific updates are enough)
      io.emit("ride_cancelled", {
        rideId: ride.id,
        status: "CANCELLED",
        cancelledBy: cancellingUserType,
        reason: cancellationReason,
      });
    }

    console.log(
      `[handleRideCancellation] Sending final response for ride ${ride.id}.`
    );
    res.json(responsePayload);
  } catch (error) {
    console.error(
      `[handleRideCancellation] General error cancelling ride ${rideId}:`,
      error
    );
    // Avoid sending response if headers already sent (e.g., from transaction error)
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to cancel ride" });
    }
  }
};

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

export const generateOTP = (): number => {
  return Math.floor(1000 + Math.random() * 9000);
};

const validateOTP = (ride: any, otp: number): boolean => {
  return ride.otp === otp;
};

export const validateRideChatAccess = async (
  rideId: string,
  userId: string
): Promise<boolean> => {
  try {
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        OR: [{ userId }, { driverId: userId }],
        status: {
          in: [
            RideStatus.ACCEPTED,
            RideStatus.DRIVER_ARRIVED,
            RideStatus.RIDE_STARTED,
            RideStatus.PAYMENT_PENDING,
          ],
        },
      },
    });

    return !!ride;
  } catch (error) {
    console.error("Error validating ride chat access:", error);
    return false;
  }
};

export const getChatMessages = async (req: Request, res: Response) => {
  const { id: rideId } = req.params;
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Validate access
    const hasAccess = await validateRideChatAccess(rideId, userId);
    if (!hasAccess) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Get messages
    const messages = await prisma.chatMessage.findMany({
      where: {
        rideId,
      },
      include: {
        sender: {
          select: {
            name: true,
            userType: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Mark messages as read
    await prisma.chatMessage.updateMany({
      where: {
        rideId,
        NOT: {
          senderId: userId,
        },
        read: false,
      },
      data: {
        read: true,
      },
    });

    res.json(messages);
  } catch (error) {
    console.error("Error fetching chat messages:", error);
    res.status(500).json({ error: "Failed to fetch chat messages" });
  }
};

export const getUserSelfieUrl = async (req: Request, res: Response) => {
  const { userId } = req.params;
  const requestingUserId = req.user?.userId;

  if (!requestingUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Find the user and include necessary details
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        userType: true,
        selfieUrl: true,
        driverDetails: {
          select: {
            dlUrl: true,
            carFrontUrl: true,
            carBackUrl: true,
          },
        },
        vendorDetails: {
          select: {
            aadharFrontUrl: true,
            aadharBackUrl: true,
            panUrl: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Construct response based on user type
    const response: any = {
      id: user.id,
      userType: user.userType,
      selfieUrl: user.selfieUrl,
    };

    // Add driver-specific URLs if user is a driver
    if (user.userType === "DRIVER" && user.driverDetails) {
      response.driverUrls = {
        dlUrl: user.driverDetails.dlUrl,
        carFrontUrl: user.driverDetails.carFrontUrl,
        carBackUrl: user.driverDetails.carBackUrl,
      };
    }

    // Add vendor-specific URLs if user is a vendor
    if (user.userType === "VENDOR" && user.vendorDetails) {
      response.vendorUrls = {
        aadharFrontUrl: user.vendorDetails.aadharFrontUrl,
        aadharBackUrl: user.vendorDetails.aadharBackUrl,
        panUrl: user.vendorDetails.panUrl,
      };
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching user selfie URL:", error);
    res.status(500).json({
      error: "Failed to fetch user details",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Add a new function to get waiting time details
export const getWaitingTimeDetails = async (req: Request, res: Response) => {
  const { id: rideId } = req.params;

  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { userId, userType } = req.user;

  try {
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        OR: [{ userId }, userType === "DRIVER" ? { driverId: userId } : {}],
        status: RideStatus.DRIVER_ARRIVED,
      },
    });

    if (!ride) {
      return res.status(404).json({
        error: "Ride not found or driver has not arrived yet",
      });
    }

    if (!ride.waitingStartTime) {
      return res.status(400).json({
        error: "Waiting time has not started yet",
      });
    }

    const now = new Date();
    const waitingTimeMs =
      now.getTime() - new Date(ride.waitingStartTime).getTime();
    const waitingMinutes = Math.floor(waitingTimeMs / (1000 * 60));
    const chargableMinutes = Math.max(0, waitingMinutes - FREE_WAITING_MINUTES);
    const currentWaitingCharges = chargableMinutes * WAITING_CHARGE_PER_MINUTE;

    return res.json({
      success: true,
      waitingTimeDetails: {
        waitingStartTime: ride.waitingStartTime,
        currentWaitingMinutes: waitingMinutes,
        freeWaitingMinutes: FREE_WAITING_MINUTES,
        chargableMinutes: chargableMinutes,
        currentWaitingCharges: currentWaitingCharges,
        chargePerMinute: WAITING_CHARGE_PER_MINUTE,
        elapsedTimeMs: waitingTimeMs,
      },
    });
  } catch (error) {
    console.error("Error getting waiting time details:", error);
    return res.status(500).json({
      error: "Failed to get waiting time details",
    });
  }
};

/**
 * Gets unread message count for a ride chat
 * @param req Request with rideId and userId parameters
 * @param res Response with unread message count
 */
export const getUnreadMessageCount = async (req: Request, res: Response) => {
  const { rideId, userId } = req.params;

  try {
    // Check if user has access to this ride chat
    const hasAccess = await validateRideChatAccess(rideId, userId);
    if (!hasAccess) {
      return res.status(403).json({
        error: "Unauthorized access to chat",
      });
    }

    // Count unread messages for this user in this ride
    const unreadCount = await prisma.chatMessage.count({
      where: {
        rideId,
        senderId: { not: userId }, // Messages not sent by this user
        read: false, // That are unread
      },
    });

    return res.json({ unreadCount });
  } catch (error) {
    console.error("Error getting unread message count:", error);
    return res.status(500).json({
      error: "Failed to get unread message count",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
