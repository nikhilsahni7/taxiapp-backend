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
  calculateFinalAmount,
  initiateRazorpayPayment,
} from "./paymentController";

import axios from "axios";
import { io } from "../server";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

const prisma = new PrismaClient();
const WAIT_TIME_THRESHOLD = 5; // minutes
const EXTRA_CHARGE_PER_MINUTE = 2;
const DRIVER_REQUEST_TIMEOUT = 15000;
const MAX_SEARCH_RADIUS = 15; // kilometers
const INITIAL_SEARCH_RADIUS = 3; // kilometers

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
  AIRPORT_PARKING: 250,
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
  category: string
): Promise<{
  baseFare: number;
  totalFare: number;
  charges: TaxAndCharges;
}> => {
  const baseFare = 50;
  let perKmRate = 0;

  // Calculate per km rate based on distance and category
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

  const charges = await calculateTaxAndCharges(
    pickupLocation,
    dropLocation,
    category
  );

  const distanceFare = distance * perKmRate;
  const totalFare =
    baseFare +
    distanceFare +
    charges.stateTax +
    charges.tollCharges +
    charges.airportCharges +
    charges.mcdCharges;

  return {
    baseFare: baseFare + distanceFare,
    totalFare,
    charges,
  };
};

// Update the getFareEstimation endpoint
export const getFareEstimation = async (req: Request, res: Response) => {
  const { pickupLocation, dropLocation, carrierRequested } = req.body;
  const carrierCharge = carrierRequested ? 30 : 0;

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);

    // Calculate fares for all categories with taxes and charges
    const categories: CarCategory[] = ["mini", "sedan", "suv"];
    const estimates: Record<CarCategory, FareEstimate> = {} as Record<
      CarCategory,
      FareEstimate
    >;

    for (const category of categories) {
      const fareDetails = await calculateFare(
        pickupLocation,
        dropLocation,
        distance,
        category
      );

      estimates[category] = {
        ...fareDetails,
        distance,
        duration,
        currency: "INR",
        totalFare: fareDetails.totalFare + carrierCharge,
        carrierCharge,
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
  paymentMode: PaymentMode | undefined
) {
  const distance = await calculateDistance(pickupLocation, dropLocation);
  const duration = await calculateDuration(pickupLocation, dropLocation);
  const totalFare = await calculateFare(
    pickupLocation,
    dropLocation,
    distance,
    carCategory
  );

  return prisma.ride.create({
    data: {
      userId,
      pickupLocation,
      dropLocation,
      carCategory,
      fare: totalFare.totalFare,
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

async function findAndRequestDrivers(ride: any) {
  let currentRadius = INITIAL_SEARCH_RADIUS;
  const attemptedDrivers = new Set<string>();
  const searchedDrivers: any[] = [];

  while (currentRadius <= MAX_SEARCH_RADIUS) {
    // Add a check for ride status before continuing search
    const currentRideStatus = await prisma.ride.findUnique({
      where: { id: ride.id },
      select: { status: true },
    });

    if (currentRideStatus?.status !== RideStatus.SEARCHING) {
      return {
        success: true,
        message: "Ride already assigned",
        searchedDrivers,
        finalRadius: currentRadius,
      };
    }

    // Add filter for carrier if requested
    const filterOptions = ride.carrierRequested ? { hasCarrier: true } : {};

    const drivers = await searchAvailableDrivers(
      ride.pickupLocation,
      currentRadius,
      filterOptions // Pass carrier filter
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
        attemptedDrivers.add(driver.driverId);

        if (!driver.socketId) continue;

        try {
          // Check ride status before sending request
          const currentRide = await prisma.ride.findUnique({
            where: { id: ride.id },
            select: {
              status: true,
              driverId: true,
              userId: true,
              user: {
                select: {
                  name: true,
                  phone: true,
                },
              },
            },
          });

          if (currentRide?.status !== RideStatus.SEARCHING) {
            return {
              success: true,
              message: "Ride already accepted",
              searchedDrivers,
              // finalRadius: currentRadius,
              ride: currentRide,
            };
          }

          // Calculate metrics and emit request
          const pickupMetrics = await calculatePickupMetrics(
            driver,
            ride.pickupLocation
          );

          io.to(driver.driverId).emit("ride_request", {
            rideId: ride.id,
            pickupLocation: ride.pickupLocation,
            dropLocation: ride.dropLocation,
            fare: ride.fare,
            distance: ride.distance,
            duration: ride.duration,
            paymentMode: ride.paymentMode,
            ...pickupMetrics,
            userId: currentRide.userId,
            userName: currentRide.user?.name,
            userPhone: currentRide.user?.phone,
          });

          const response = await waitForDriverResponse(
            ride.id,
            driver.driverId
          );

          if (response.accepted) {
            // Use transaction to ensure atomicity
            const result = await prisma.$transaction(async (prisma) => {
              // Final check before updating
              const finalCheck = await prisma.ride.findFirst({
                where: {
                  id: ride.id,
                  status: RideStatus.SEARCHING,
                  driverId: null,
                },
                select: { status: true },
              });

              if (!finalCheck) {
                return null;
              }

              // Update ride with driver and metrics
              return prisma.ride.update({
                where: {
                  id: ride.id,
                },
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
                      driverDetails: true,
                    },
                  },
                  user: true,
                },
              });
            });

            if (result) {
              // Notify user about accepted ride
              io.to(result.userId).emit("ride_status_update", {
                rideId: ride.id,
                status: RideStatus.ACCEPTED,
                driverId: driver.driverId,
                pickupDistance: pickupMetrics.pickupDistance,
                pickupDuration: pickupMetrics.pickupDuration,
              });

              // Broadcast ride unavailability
              io.emit("ride_unavailable", { rideId: ride.id });

              return {
                success: true,
                message: "Driver found successfully",
                searchedDrivers,
                finalRadius: currentRadius,
                ride: result,
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

// Modify createRide to handle car rentals
export const createRide = async (req: Request, res: Response) => {
  const {
    pickupLocation,
    dropLocation,
    carCategory,
    paymentMode,
    isCarRental,
    rentalPackageHours,
    carrierRequested,
  } = req.body;

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const userId = req.user.userId;

  try {
    let rideData: any = {
      userId,
      pickupLocation,
      carCategory,
      status: RideStatus.SEARCHING,
      paymentMode: paymentMode || PaymentMode.CASH,
      otp: generateOTP().toString(),
      rideType: isCarRental ? RideType.CAR_RENTAL : RideType.LOCAL,
      carrierRequested: carrierRequested || false,
      carrierCharge: carrierRequested ? 30 : 0,
    };

    if (isCarRental) {
      // For car rental, initialize rental-specific fields
      const isValidCategory = isValidCarCategory(carCategory);
      const isValidHours = isValidPackageHours(rentalPackageHours);

      if (!isValidCategory) {
        return res.status(400).json({ error: "Invalid car category" });
      }

      if (!isValidHours) {
        return res.status(400).json({ error: "Invalid package hours" });
      }

      const packageDetails =
        RENTAL_PACKAGES[carCategory.toLowerCase() as CarCategory][
          rentalPackageHours
        ];

      rideData = {
        ...rideData,
        isCarRental: true,
        rentalPackageHours,
        rentalPackageKms: packageDetails.km,
        rentalBasePrice: packageDetails.price + rideData.carrierCharge,
        dropLocation: "", // Initially empty for rentals
      };
    } else {
      // For regular rides, include drop location and calculate fare
      rideData.dropLocation = dropLocation;
      const distance = await calculateDistance(pickupLocation, dropLocation);
      const duration = await calculateDuration(pickupLocation, dropLocation);
      const fareDetails = await calculateFare(
        pickupLocation,
        dropLocation,
        distance,
        carCategory
      );

      rideData = {
        ...rideData,
        distance,
        duration,
        fare: fareDetails.totalFare + rideData.carrierCharge,
      };
    }

    // Create the ride
    const ride = await prisma.ride.create({
      data: rideData,
      include: {
        user: {
          select: { name: true, phone: true },
        },
      },
    });

    // Start driver search process
    const driverSearchResult = await findAndRequestDrivers(ride);

    // Handle no driver found case
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

//  updateRideStatus with wait timer and extra charges
export const updateRideStatus = async (req: Request, res: Response) => {
  const rideId = req.params.id;
  const { status, otp, cancellationReason } = req.body;
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
        return handleRideCancellation(ride, userType, cancellationReason, res);
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
        totalAmount: rentalCalculation.totalAmount,
      };

      finalAmount = rentalCalculation.totalAmount;
    } else {
      finalAmount = calculateFinalAmount(ride);
      // Ensure carrier charge is included in final amount
      updateData.totalAmount = finalAmount;
    }

    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: updateData,
      include: {
        user: true,
        driver: true,
      },
    });

    // Emit ride completion event with carrier details if applicable
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      finalLocation,
      amount: finalAmount,
      paymentMode: ride.paymentMode,
      isCarRental: ride.isCarRental,
      carrierRequested: ride.carrierRequested,
      carrierCharge: ride.carrierCharge,
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

    res.json({ ride, driverStatus });
  } catch (error) {
    console.error("Error fetching ride details:", error);
    res.status(500).json({ error: "Failed to retrieve ride details" });
  }
};

const handleRideCancellation = async (
  ride: any,
  userType: string,
  cancellationReason: string,
  res: Response
) => {
  try {
    console.log(
      `Starting ride cancellation for ride ${ride.id} by ${userType} with reason: ${cancellationReason}`
    );
    let cancellationFee = 0;

    if (ride.driverAcceptedAt) {
      const currentTime = new Date();
      const acceptedTime = new Date(ride.driverAcceptedAt);
      const timeDifference =
        (currentTime.getTime() - acceptedTime.getTime()) / 60000; // Difference in minutes

      if (timeDifference > 3) {
        cancellationFee = 50;
      }
      console.log(
        `Time diff: ${timeDifference} minutes; Cancellation fee: ${cancellationFee}`
      );
    }

    console.log("Updating ride in DB...");
    const updatedRide = await prisma.ride.update({
      where: { id: ride.id },
      data: {
        status: RideStatus.CANCELLED,
        cancellationReason,
        cancellationFee,
        cancelledBy: userType as CancelledBy,
        totalAmount: {
          increment: cancellationFee,
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
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });
    console.log("Ride updated:", updatedRide);

    // Immediate notification to both users and drivers
    emitRideStatusUpdate(updatedRide, "CANCELLED");

    // Broadcast cancellation to all connected clients
    io.emit("ride_cancelled", {
      rideId: ride.id,
      status: "CANCELLED",
      cancelledBy: userType,
      reason: cancellationReason,
    });

    if (cancellationFee > 0) {
      if (userType === "USER") {
        console.log("Updating user's wallet...");
        await prisma.wallet.update({
          where: { userId: ride.userId },
          data: {
            balance: {
              decrement: cancellationFee,
            },
          },
        });
        console.log("Creating refund transaction for user...");
        await prisma.transaction.create({
          data: {
            amount: cancellationFee,
            currency: "INR",
            type: TransactionType.REFUND,
            status: TransactionStatus.COMPLETED,
            senderId: ride.userId,
            receiverId: ride.driverId,
            rideId: ride.id,
            description: `Cancellation fee (user) for ride ${ride.id}`,
          },
        });
      } else if (userType === "DRIVER" && ride.driverId) {
        console.log("Updating driver's wallet...");
        await prisma.wallet.update({
          where: { userId: ride.driverId },
          data: {
            balance: {
              decrement: cancellationFee,
            },
          },
        });
        console.log("Creating refund transaction for driver...");
        await prisma.transaction.create({
          data: {
            amount: cancellationFee,
            currency: "INR",
            type: TransactionType.REFUND,
            status: TransactionStatus.COMPLETED,
            senderId: ride.driverId,
            receiverId: ride.userId,
            rideId: ride.id,
            description: `Cancellation fee (driver) for ride ${ride.id}`,
          },
        });
      }
    }

    console.log("Sending cancellation success response...");
    res.json({
      success: true,
      message: "Ride cancelled successfully",
      ride: updatedRide,
      cancellationFee,
      cancelledBy: userType,
    });
  } catch (error) {
    console.error("Error cancelling ride:", error);
    res.status(500).json({ error: "Failed to cancel ride" });
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
