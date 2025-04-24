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
    // This case should ideally be handled by auth middleware, but good to double-check
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const distance = await calculateDistance(pickupLocation, dropLocation);
    const duration = await calculateDuration(pickupLocation, dropLocation);

    // Fetch user's outstanding cancellation fee
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { outstandingCancellationFee: true },
    });

    const outstandingFee = user?.outstandingCancellationFee ?? 0;
    console.log(
      `[getFareEstimation] User ${userId} outstanding fee: ${outstandingFee}`
    );

    // Calculate fares for all categories with taxes and charges
    const categories: CarCategory[] = ["mini", "sedan", "suv"];
    const estimates: Record<
      CarCategory,
      FareEstimate & { outstandingCancellationFee?: number }
    > = {} as Record<
      CarCategory,
      FareEstimate & { outstandingCancellationFee?: number } // Add fee to type
    >;

    for (const category of categories) {
      const fareDetails = await calculateFare(
        pickupLocation,
        dropLocation,
        distance,
        category,
        carrierRequested
      );

      // Add the outstanding fee to the total fare estimate
      const totalFareWithFee = fareDetails.totalFare + outstandingFee;

      estimates[category] = {
        ...fareDetails,
        distance,
        duration,
        currency: "INR",
        totalFare: totalFareWithFee, // Show total including the fee
        carrierCharge: fareDetails.carrierCharge,
        outstandingCancellationFee:
          outstandingFee > 0 ? outstandingFee : undefined, // Include the fee amount if > 0
      };
    }

    res.json({
      estimates,
      carrierRequested: carrierRequested || false,
      // Optionally include the fee at the top level as well for clarity
      outstandingCancellationFee:
        outstandingFee > 0 ? outstandingFee : undefined,
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

    // Prepare filter options including carrier and car category
    const filterOptions: { hasCarrier?: boolean; carCategory?: string } = {};
    if (ride.carrierRequested) {
      filterOptions.hasCarrier = true;
    }
    // Ensure we pass the carCategory from the ride object
    if (ride.carCategory) {
      filterOptions.carCategory = ride.carCategory; // Pass the requested category
    } else {
       console.warn(`[findAndRequestDrivers] Ride ${ride.id} is missing carCategory for filtering.`);
       
    }

    console.log(
      `[findAndRequestDrivers] Searching drivers for ride ${ride.id} in radius ${currentRadius}km with filters:`, filterOptions
    );

    // Call searchAvailableDrivers with the filter options
    const drivers = await searchAvailableDrivers(
      ride.pickupLocation,
      currentRadius,
      filterOptions // Pass the options object
    );

    console.log(`[findAndRequestDrivers] Found ${drivers.length} suitable drivers in radius ${currentRadius}km.`);

    const newDrivers = drivers.filter((d) => !attemptedDrivers.has(d.driverId));

    if (newDrivers.length > 0) {
      searchedDrivers.push(
        ...newDrivers.map((d) => ({
          driverId: d.driverId,
          distance: d.distance,
          status: "searched",
          hasCarrier: d.driver?.driverDetails?.hasCarrier || false,
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
              carrierRequested: true,
              carrierCharge: true,
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
            fare: ride.totalAmount,
            distance: ride.distance,
            duration: ride.duration,
            paymentMode: ride.paymentMode,
            carrierRequested: ride.carrierRequested,
            carrierCharge: ride.carrierCharge,
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
                carrierRequested: ride.carrierRequested,
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
    message: ride.carrierRequested
      ? "No drivers with carrier available"
      : "No available drivers found",
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
    // *** START: Fetch user's outstanding fee ***
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { outstandingCancellationFee: true },
    });
    const outstandingFee = user?.outstandingCancellationFee ?? 0;
    let feeAppliedToRide = false; // Flag to track if fee was added
    if (outstandingFee > 0) {
      console.log(
        `[createRide] User ${userId} has outstanding fee: ${outstandingFee}. Will apply to this ride.`
      );
      feeAppliedToRide = true;
    }
    // *** END: Fetch user's outstanding fee ***

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
    let calculatedBaseFare = 0; // To store fare BEFORE adding outstanding fee

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
        totalAmount: baseRentalPrice, // Initial total is base price for rentals
        dropLocation: "", // Default empty drop location for rentals
        actualKmsTravelled: 0, // Initialize rental specific fields
        actualMinutes: 0,
        extraKmCharges: 0,
        extraMinuteCharges: 0,
      };
      console.log(`[createRide] Rental data prepared (before fee):`, rideData);
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
        fare: fareDetails.totalFare, // Store the TOTAL fare including taxes/charges
        totalAmount: fareDetails.totalFare, // Store total calculated fare including taxes/carrier
      };
      console.log(
        `[createRide] Local ride data prepared (before fee):`,
        rideData
      );
    }

    // *** START: Add outstanding fee to totalAmount ***
    rideData.totalAmount = calculatedBaseFare + outstandingFee;
    if (feeAppliedToRide) {
      console.log(
        `[createRide] Added outstanding fee ${outstandingFee}. New totalAmount: ${rideData.totalAmount}`
      );
    }
    // *** END: Add outstanding fee to totalAmount ***

    // 5. Create the Ride record and handle fee reset/transaction within a DB transaction
    console.log(
      `[createRide] Creating ride record in database (potentially with fee logic)...`
    );

    const ride = await prisma.$transaction(async (tx) => {
      // Create the ride first
      const newRide = await tx.ride.create({
        data: rideData, // Use the prepared rideData with updated totalAmount
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
              outstandingCancellationFee: true,
            },
          }, // Include fee status
          driver: {
            select: { id: true, name: true, phone: true, driverDetails: true },
          },
        },
      });

      // If a fee was applied, reset user's fee and create transaction
      if (feeAppliedToRide && outstandingFee > 0) {
        console.log(
          `[createRide Transaction] Resetting user ${userId}'s outstanding fee and creating transaction.`
        );
        // Reset user's outstanding fee
        await tx.user.update({
          where: { id: userId },
          data: { outstandingCancellationFee: 0 },
        });

        // Create a transaction record for applying the fee
        await tx.transaction.create({
          data: {
            amount: outstandingFee,
            currency: "INR",
            type: TransactionType.USER_CANCELLATION_FEE_APPLIED, // Use specific type
            status: TransactionStatus.COMPLETED,
            senderId: userId, // User 'paid' the fee via this ride
            receiverId: null, // Or system/admin ID
            rideId: newRide.id, // Link to the ride where fee was applied
            description: `Applied outstanding cancellation fee of ${outstandingFee} to ride ${newRide.id}`,
          },
        });
        console.log(
          `[createRide Transaction] User fee reset and transaction created for ride ${newRide.id}.`
        );
      }

      return newRide; // Return the created ride from the transaction
    });

    console.log(
      `[createRide] Ride record created/updated successfully with ID: ${ride.id}. Final Total Amount: ${ride.totalAmount}`
    );

    // 6. Respond IMMEDIATELY
    console.log(
      `[createRide] Sending immediate response (201) for ride ${ride.id}`
    );
    res.status(201).json({
      message: feeAppliedToRide
        ? `Ride created, outstanding fee of ${outstandingFee} applied. Searching for driver...`
        : "Ride created, searching for driver...",
      ride: ride, // Send the full created ride object back
      outstandingFeeApplied: feeAppliedToRide ? outstandingFee : 0, // Indicate if fee was applied
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
  await prisma.ride.update({
    where: { id: ride.id },
    data: {
      driverArrivedAt: new Date(),
      waitingStartTime: new Date(),
    },
  });
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

    await prisma.ride.update({
      where: { id: ride.id },
      data: {
        waitingMinutes,
        waitingCharges,
        fare: ride.fare + waitingCharges, // Add waiting charges to the fare
      },
    });

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
      ].includes(ride.status)
    ) {
      console.log(
        `[handleRideCancellation] Ride ${rideId} already finished or cancelled. Status: ${ride.status}`
      );
      return res
        .status(400)
        .json({ error: "Ride cannot be cancelled in its current state" });
    }

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
        // User cancels after driver arrived - Add fee to user's outstanding balance
        console.log(
          `[handleRideCancellation] Fee applies. Updating user ${ride.userId}'s outstanding fee.`
        );
        await prisma.user.update({
          where: { id: ride.userId },
          data: {
            outstandingCancellationFee: {
              increment: cancellationFee,
            },
          },
        });
        responsePayload.message = `Ride cancelled. A fee of ${cancellationFee} INR will be added to your next ride.`;
        console.log(
          `[handleRideCancellation] User ${ride.userId} outstanding fee updated.`
        );
      }
      // Update ride status (common for user cancellation)
      updatedRideData = await prisma.ride.update({
        where: { id: ride.id },
        data: {
          status: RideStatus.CANCELLED,
          cancellationReason,
          cancellationFee, // Record the fee on the ride itself for history
          cancelledBy: CancelledBy.USER, // Use the enum
          driverId: null, // Ensure driver is unassigned if cancelled by user
        },
        include: { user: true, driver: true }, // Include relations for notification
      });
      responsePayload.ride = updatedRideData;
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
          feeAppliedToNextRide:
            cancellingUserType === UserType.USER && feeApplies, // Indicate if fee affects user's next ride
        });
      }
      if (updatedRideData.driverId) {
        io.to(updatedRideData.driverId).emit("ride_status_update", {
          rideId: ride.id,
          status: RideStatus.CANCELLED,
          reason: cancellationReason,
          cancelledBy: cancellingUserType,
          cancellationFee: cancellationFee, // Send fee info
          feeDeducted: cancellingUserType === UserType.DRIVER && feeApplies, // Indicate if fee was deducted
        });
      }

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
