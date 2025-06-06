import {
  CancelledBy,
  PaymentMode,
  Prisma,
  PrismaClient,
  RideStatus,
  TransactionStatus,
  TransactionType,
  UserType,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { searchAvailableDrivers } from "../lib/driverService";
import { getCoordinatesAndAddress } from "../lib/locationService";
import {
  sendTaxiSureBookingNotification,
  sendTaxiSureRegularNotification,
  validateFcmToken,
} from "../utils/sendFcmNotification";
import { calculateDistance, calculateDuration } from "./rideController";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

interface RentalPackage {
  km: number;
  price: number;
}

interface CarCategory {
  [key: number]: RentalPackage;
}

interface RentalPackages {
  mini: CarCategory;
  sedan: CarCategory;
  suv: CarCategory;
}

// Package configurations
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

const EXTRA_KM_RATES: Record<keyof RentalPackages, number> = {
  mini: 14,
  sedan: 16,
  suv: 18,
};

const EXTRA_MINUTE_RATE = 2;

// Constants for waiting time calculation
const FREE_WAITING_MINUTES = 3;
const WAITING_CHARGE_PER_MINUTE = 3;

/**
 * Helper function to send booking notifications to multiple drivers
 */
async function sendBookingNotificationsToDrivers(
  driverIds: string[],
  rentalData: {
    bookingId: string;
    amount: string;
    pickupLocation: string;
    rideType: string;
    distance?: string;
    duration?: string;
    carrierRequested?: boolean;
  }
): Promise<void> {
  try {
    console.log(`🔍 Looking for FCM tokens for driver IDs:`, driverIds);

    // Fetch drivers' FCM tokens
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
        `⚠️ No drivers found with valid FCM tokens for rental ${rentalData.bookingId}`
      );
      return;
    }

    console.log(
      `📤 Sending booking notifications to ${drivers.length} drivers for rental ${rentalData.bookingId}`
    );

    // Send notifications to all drivers with valid FCM tokens
    const notificationPromises = drivers.map(async (driver) => {
      if (!driver.fcmToken || !validateFcmToken(driver.fcmToken)) {
        console.warn(`❌ Invalid FCM token for driver ${driver.id}`);
        return;
      }

      try {
        const notificationData = {
          bookingId: rentalData.bookingId,
          amount: rentalData.amount,
          pickupLocation: rentalData.pickupLocation,
          dropLocation: "Car Rental", // For rental, drop is not fixed
          distance: rentalData.distance || "Package based",
          duration: rentalData.duration || "Package based",
          rideType: rentalData.rideType,
          carrierRequested: rentalData.carrierRequested,
        };

        await sendTaxiSureBookingNotification(
          driver.fcmToken,
          notificationData
        );

        console.log(
          `✅ Booking notification sent to driver ${driver.name || driver.id}`
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
    console.error("❌ Error sending booking notifications to drivers:", error);
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
      `📤 Attempting to send notification to user ${userId}: ${title}`
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true, name: true },
    });

    console.log(
      `🔍 User found: ${user?.name || "Unknown"}, Has FCM token: ${!!user?.fcmToken}`
    );

    if (!user?.fcmToken) {
      console.warn(`❌ No FCM token found for user ${userId}`);
      return;
    }

    if (!validateFcmToken(user.fcmToken)) {
      console.warn(`❌ Invalid FCM token for user ${userId}`);
      return;
    }

    await sendTaxiSureRegularNotification(
      user.fcmToken,
      title,
      body,
      notificationType,
      additionalData
    );

    console.log(
      `✅ Notification sent to user ${user.name || userId}: ${title}`
    );
  } catch (error) {
    console.error(`❌ Failed to send notification to user ${userId}:`, error);
  }
}

// Create a new car rental booking
export const createCarRental = async (req: Request, res: Response) => {
  const { carCategory, packageHours, paymentMode, carrierRequested } = req.body;
  let { pickupLocation, pickupLat, pickupLng } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Fetch user details including outstanding fee
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { outstandingCancellationFee: true },
    });

    if (!user) {
      // This shouldn't happen if req.user is set, but good practice
      return res.status(404).json({ error: "User not found" });
    }

    const outstandingFee = user.outstandingCancellationFee || 0;

    // Validate coordinates
    if (!pickupLat || !pickupLng) {
      const locationData = await getCoordinatesAndAddress(pickupLocation);
      if (!locationData) {
        return res.status(400).json({ error: "Invalid pickup location" });
      }
      pickupLat = locationData.lat;
      pickupLng = locationData.lng;
      pickupLocation = locationData.formattedAddress;
    }

    const packageDetails =
      RENTAL_PACKAGES[carCategory as keyof RentalPackages]?.[packageHours];
    if (!packageDetails) {
      return res.status(400).json({ error: "Invalid package selected" });
    }

    // Calculate carrier charge if requested
    const carrierCharge = carrierRequested ? 30 : 0;
    // Calculate base price including carrier charge
    let totalBasePrice = packageDetails.price + carrierCharge;

    // Apply outstanding fee
    let appliedOutstandingFee = 0;
    const rentalMetadata: Prisma.JsonObject = {}; // Initialize metadata

    if (outstandingFee > 0) {
      appliedOutstandingFee = outstandingFee;
      totalBasePrice += appliedOutstandingFee; // Add fee to the total base price
      rentalMetadata.appliedOutstandingFee = appliedOutstandingFee; // Store in metadata
      // Note: We will reset the user's outstanding fee upon successful payment later
    }

    console.log("Creating rental with metadata:", rentalMetadata);
    // >> prisma.ride.create({ data: { ..., metadata: rentalMetadata } })

    // Create rental booking with coordinates, carrier option, fee, and metadata
    const rental = await prisma.ride.create({
      data: {
        userId: req.user.userId,
        pickupLocation,
        pickupLat,
        pickupLng,
        carCategory,
        status: RideStatus.SEARCHING,
        paymentMode: paymentMode || PaymentMode.CASH,
        isCarRental: true,
        rentalPackageHours: packageHours,
        rentalPackageKms: packageDetails.km,
        rentalBasePrice: totalBasePrice, // Use the potentially increased base price
        carrierRequested: carrierRequested || false,
        carrierCharge: carrierCharge,
        dropLocation: "", // not needed for car rental
        otp: Math.floor(1000 + Math.random() * 9000).toString(),
        metadata: rentalMetadata, // Add metadata here
        // totalAmount will be calculated later, ensure fee is included there too
      },
    });

    // Start driver search process with carrier filter if required
    const searchResult = await findDriversForRental(rental, carCategory);

    // Include applied fee in response
    return res.status(201).json({
      rental: {
        ...rental,
        // Explicitly add applied fee to response for frontend clarity
        appliedOutstandingFee: appliedOutstandingFee,
      },
      searchResult,
      // Optional: You might want to send the breakdown explicitly
      // priceDetails: {
      //   packagePrice: packageDetails.price,
      //   carrierCharge: carrierCharge,
      //   appliedOutstandingFee: appliedOutstandingFee,
      //   totalBasePrice: totalBasePrice
      // }
    });
  } catch (error) {
    console.error("Error creating car rental:", error);
    return res.status(500).json({ error: "Failed to create car rental" });
  }
};

// Get rental status and driver location
export const getRentalStatus = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const rental = await prisma.ride.findUnique({
      where: { id },
      include: {
        driver: {
          include: {
            driverStatus: true,
          },
        },
        user: {
          select: {
            name: true,
            phone: true,
            email: true,
            selfieUrl: true,
          },
        },
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }

    // Calculate current metrics if driver is assigned using coordinates
    let currentMetrics = null;
    if (rental.driver?.driverStatus && rental.pickupLat && rental.pickupLng) {
      const { locationLat, locationLng } = rental.driver.driverStatus;
      currentMetrics = {
        pickupDistance: await calculateDistance(
          `${locationLat},${locationLng}`,
          `${rental.pickupLat},${rental.pickupLng}`
        ),
        pickupDuration: await calculateDuration(
          `${locationLat},${locationLng}`,
          `${rental.pickupLat},${rental.pickupLng}`
        ),
      };
    }

    // Calculate waiting time details if driver has arrived
    let waitingTimeDetails = null;
    if (
      rental.status === RideStatus.DRIVER_ARRIVED &&
      rental.waitingStartTime
    ) {
      const now = new Date();
      const waitingTimeMs = now.getTime() - rental.waitingStartTime.getTime();
      const waitingMinutes = Math.floor(waitingTimeMs / (1000 * 60));
      const chargableMinutes = Math.max(
        0,
        waitingMinutes - FREE_WAITING_MINUTES
      );

      waitingTimeDetails = {
        waitingStartTime: rental.waitingStartTime,
        currentWaitingMinutes: waitingMinutes,
        freeWaitingMinutes: FREE_WAITING_MINUTES,
        chargableMinutes: chargableMinutes,
        currentWaitingCharges: chargableMinutes * WAITING_CHARGE_PER_MINUTE,
        chargePerMinute: WAITING_CHARGE_PER_MINUTE,
      };
    }

    console.log(currentMetrics);

    return res.json({
      rental,
      currentMetrics,
      waitingTimeDetails,
    });
  } catch (error) {
    console.error("Error getting rental status:", error);
    return res.status(500).json({ error: "Failed to get rental status" });
  }
};

// End rental and calculate final charges

// Helper function to find available drivers
async function findDriversForRental(rental: any, carCategory: string) {
  let currentRadius = 3;
  const maxRadius = 15;
  const attemptedDrivers = new Set<string>();

  // Retrieve existing metadata, default to empty object if null/undefined
  const existingMetadata = (rental.metadata as Prisma.JsonObject | null) ?? {};

  while (currentRadius <= maxRadius) {
    // Include carrier filter if requested AND the car category filter
    const filterOptions = {
      hasCarrier: rental.carrierRequested,
      carCategory: carCategory, // Add carCategory to filter options
    };

    console.log(`🔍 Searching for drivers within ${currentRadius}km radius...`);
    console.log(`📍 Location: ${rental.pickupLat},${rental.pickupLng}`);
    console.log(`🚗 Filter options:`, filterOptions);

    const drivers = await searchAvailableDrivers(
      `${rental.pickupLat},${rental.pickupLng}`,
      currentRadius,
      filterOptions // Pass the updated filter options
    );

    console.log(
      `👥 Found ${drivers.length} total drivers in radius ${currentRadius}km`
    );

    const newDrivers = drivers.filter((d) => !attemptedDrivers.has(d.driverId));

    console.log(
      `✨ Found ${newDrivers.length} new drivers (${drivers.length - newDrivers.length} already attempted)`
    );
    console.log(
      `🆔 New driver IDs:`,
      newDrivers.map((d) => d.driverId)
    );

    if (newDrivers.length > 0) {
      // Prepare the new metadata related to driver search
      const driverSearchMetadata: Prisma.JsonObject = {
        availableDrivers: newDrivers.map((d) => ({
          driverId: d.driverId,
          distance: d.distance,
          status: "pending",
        })),
        expiresAt: new Date(Date.now() + 60000).toISOString(), // 60 seconds from now
      };

      // Merge existing metadata with the new driver search metadata
      const mergedMetadata = {
        ...existingMetadata,
        ...driverSearchMetadata,
      };
      console.log("Merging metadata in findDriversForRental:", mergedMetadata);

      // Update the ride with the merged metadata
      await prisma.ride.update({
        where: { id: rental.id },
        data: { metadata: mergedMetadata }, // Use the merged object
      });

      // Send booking notifications to all new drivers
      const driverIds = newDrivers.map((d) => d.driverId);
      console.log(
        `🔔 About to send booking notifications to ${driverIds.length} drivers for rental ${rental.id}`
      );

      try {
        await sendBookingNotificationsToDrivers(driverIds, {
          bookingId: rental.id,
          amount: `₹${rental.rentalBasePrice}`,
          pickupLocation: rental.pickupLocation,
          rideType: `${rental.carCategory?.toUpperCase()} - ${rental.rentalPackageHours}hrs`,
          distance: `${rental.rentalPackageKms}km`,
          duration: `${rental.rentalPackageHours}hrs`,
          carrierRequested: rental.carrierRequested,
        });
        console.log(
          `✅ Booking notifications sent successfully for rental ${rental.id}`
        );
      } catch (notificationError) {
        console.error(
          `❌ Failed to send booking notifications for rental ${rental.id}:`,
          notificationError
        );
      }

      // Schedule automatic cancellation after 60 seconds
      setTimeout(async () => {
        const currentRental = await prisma.ride.findUnique({
          where: { id: rental.id },
        });

        if (currentRental?.status === RideStatus.SEARCHING) {
          await prisma.ride.update({
            where: { id: rental.id },
            data: {
              status: RideStatus.CANCELLED,
              cancellationReason: "No driver accepted within time limit",
              cancelledBy: CancelledBy.SYSTEM,
            },
          });
        }
      }, 60000);

      return {
        success: true,
        message: "Drivers found",
        driversCount: newDrivers.length,
        expiresAt: driverSearchMetadata.expiresAt, // Return expiry from the new part
      };
    }

    currentRadius += 2;
  }

  return {
    success: false,
    message: rental.carrierRequested
      ? "No drivers with carrier available"
      : "No drivers found",
    driversCount: 0,
  };
}

// Get available rentals for driver
export const getAvailableRentals = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const rentals = await prisma.ride.findMany({
      where: {
        status: RideStatus.SEARCHING,
        isCarRental: true,
        carCategory: {
          in: ["mini", "sedan", "suv"],
        },
        metadata: {
          path: ["availableDrivers"],
          array_contains: [{ driverId: req.user.userId }],
        },
      },
    });

    return res.json(rentals);
  } catch (error) {
    console.error("Error getting available rentals:", error);
    return res.status(500).json({ error: "Failed to get available rentals" });
  }
};

// Accept rental
export const acceptRental = async (req: Request, res: Response) => {
  const { rentalId } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const rental = await prisma.ride.findFirst({
      where: {
        id: rentalId,
        status: RideStatus.SEARCHING,
        isCarRental: true,
      },
    });

    if (!rental) {
      return res
        .status(404)
        .json({ error: "Rental not found or already accepted" });
    }

    // Update rental with driver
    const updatedRental = await prisma.ride.update({
      where: { id: rentalId },
      data: {
        driverId: req.user.userId,
        status: RideStatus.ACCEPTED,
        driverAcceptedAt: new Date(),
      },
      include: {
        driver: {
          select: { name: true, phone: true },
        },
      },
    });

    // Send notification to user that driver has accepted
    await sendNotificationToUser(
      rental.userId,
      "Driver Found! 🚗",
      `${updatedRental.driver?.name || "Your driver"} has accepted your car rental request and is on the way to pickup location.`,
      "booking_confirmed",
      {
        rideId: updatedRental.id,
        driverName: updatedRental.driver?.name || "Driver",
        driverPhone: updatedRental.driver?.phone || "",
        status: "accepted",
      }
    );

    return res.json(updatedRental);
  } catch (error) {
    console.error("Error accepting rental:", error);
    return res.status(500).json({ error: "Failed to accept rental" });
  }
};

// Driver marks arrival at pickup - need to modify this to start the wait timer
export const markDriverArrived = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        driverId: req.user.userId,
        status: RideStatus.ACCEPTED,
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }

    const updatedRental = await prisma.ride.update({
      where: { id },
      data: {
        status: RideStatus.DRIVER_ARRIVED,
        driverArrivedAt: new Date(),
        waitingStartTime: new Date(), // Start the waiting time tracking
      },
      include: {
        driver: {
          select: { name: true, phone: true },
        },
      },
    });

    // Send notification to user that driver has arrived
    await sendNotificationToUser(
      rental.userId,
      "Driver Arrived! 📍",
      `${updatedRental.driver?.name || "Your driver"} has arrived at the pickup location. Please provide OTP: ${rental.otp}`,
      "driver_arrived",
      {
        rideId: updatedRental.id,
        driverName: updatedRental.driver?.name || "Driver",
        driverPhone: updatedRental.driver?.phone || "",
        otp: rental.otp || "",
        status: "driver_arrived",
      }
    );

    return res.json(updatedRental);
  } catch (error) {
    console.error("Error marking driver arrival:", error);
    return res.status(500).json({ error: "Failed to mark driver arrival" });
  }
};

// Start ride - need to modify to calculate waiting time charges
export const startRide = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { otp, startOdometer } = req.body;

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!startOdometer)
    return res
      .status(400)
      .json({ error: "Initial odometer reading is required" });

  try {
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        driverId: req.user.userId,
        status: RideStatus.DRIVER_ARRIVED,
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }

    if (rental.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Calculate waiting time and charges
    let waitingMinutes = 0;
    let waitingCharges = 0;

    if (rental.waitingStartTime) {
      const now = new Date();
      const waitingTimeMs = now.getTime() - rental.waitingStartTime.getTime();
      waitingMinutes = Math.floor(waitingTimeMs / (1000 * 60));

      // Only charge for waiting time beyond the free period
      const chargableMinutes = Math.max(
        0,
        waitingMinutes - FREE_WAITING_MINUTES
      );
      waitingCharges = chargableMinutes * WAITING_CHARGE_PER_MINUTE;
    }

    // Create initial location log
    const driverStatus = await prisma.driverStatus.findUnique({
      where: { driverId: req.user.userId },
    });

    // Start the ride with initial readings and waiting time charges
    const updatedRental = await prisma.ride.update({
      where: { id },
      data: {
        status: RideStatus.RIDE_STARTED,
        rideStartedAt: new Date(),
        startOdometer,
        waitingMinutes,
        waitingCharges,
        currentLat: driverStatus?.locationLat,
        currentLng: driverStatus?.locationLng,
        lastLocationUpdate: new Date(),
        locationLogs: {
          create: {
            latitude: driverStatus?.locationLat || 0,
            longitude: driverStatus?.locationLng || 0,
            heading: driverStatus?.heading || 0,
            odometer: startOdometer,
          },
        },
      },
      include: {
        locationLogs: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
        driver: {
          select: { name: true, phone: true },
        },
      },
    });

    // Send notification to user that ride has started
    await sendNotificationToUser(
      rental.userId,
      "Car Rental Started! 🚗",
      `Your car rental has started with ${updatedRental.driver?.name || "your driver"}. Enjoy your ${rental.rentalPackageHours}hr package!`,
      "ride_started",
      {
        rideId: updatedRental.id,
        driverName: updatedRental.driver?.name || "Driver",
        packageHours: rental.rentalPackageHours?.toString() || "",
        packageKms: rental.rentalPackageKms?.toString() || "",
        status: "ride_started",
      }
    );

    return res.json({
      success: true,
      rental: updatedRental,
      message: "Ride started successfully with initial odometer reading",
      waitingDetails: {
        waitingMinutes,
        chargableMinutes: Math.max(0, waitingMinutes - FREE_WAITING_MINUTES),
        waitingCharges,
        freeWaitingPeriod: FREE_WAITING_MINUTES,
      },
    });
  } catch (error) {
    console.error("Error starting ride:", error);
    return res.status(500).json({ error: "Failed to start ride" });
  }
};

// Cancel rental
export const cancelRental = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const CANCELLATION_FEE = 50; // Define the cancellation fee amount

  try {
    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      const rental = await tx.ride.findFirst({
        where: {
          id,
          // Ensure the user requesting cancellation is either the user or the driver
          OR: [{ userId: req.user!.userId }, { driverId: req.user!.userId }],
          status: {
            in: [
              RideStatus.SEARCHING,
              RideStatus.ACCEPTED,
              RideStatus.DRIVER_ARRIVED,
              RideStatus.RIDE_STARTED,
            ],
          },
        },
      });

      if (!rental) {
        // Throw an error to rollback the transaction
        throw new Error("Rental not found or cannot be cancelled");
      }

      let cancellationFeeAmount = 0;
      // Fee applies if driver arrived or ride started
      const canApplyFee =
        rental.status === RideStatus.DRIVER_ARRIVED ||
        rental.status === RideStatus.RIDE_STARTED;
      const cancelledByUser = req.user!.userType === UserType.USER;
      const cancelledByDriver = req.user!.userType === UserType.DRIVER;

      // Prepare update data for the ride
      const rideUpdateData: Prisma.RideUpdateInput = {
        status: RideStatus.CANCELLED,
        cancellationReason: reason,
        cancelledBy: req.user!.userType as CancelledBy, // Assuming UserType maps directly to CancelledBy enum names
      };

      if (canApplyFee) {
        cancellationFeeAmount = CANCELLATION_FEE;
        rideUpdateData.cancellationFee = cancellationFeeAmount; // Record the fee on the ride

        if (cancelledByUser) {
          // User cancels late: Add fee to their outstanding balance
          await tx.user.update({
            where: { id: rental.userId },
            data: {
              outstandingCancellationFee: {
                increment: cancellationFeeAmount,
              },
            },
          });
        } else if (cancelledByDriver && rental.driverId) {
          // Driver cancels late: Deduct fee from their wallet

          // Check if driver has sufficient balance
          const driverWallet = await tx.wallet.findUnique({
            where: { userId: rental.driverId },
          });

          if (!driverWallet || driverWallet.balance < cancellationFeeAmount) {
            // Log issue but still cancel the ride and record the fee amount on the ride itself.
            // The fee won't be deducted from the driver's wallet in this case.
            console.warn(
              `Driver ${rental.driverId} has insufficient funds (${driverWallet?.balance}) for cancellation fee ${cancellationFeeAmount}. Fee recorded on ride ${rental.id} but not deducted from wallet.`
            );
          } else {
            // Deduct from wallet
            await tx.wallet.update({
              where: { userId: rental.driverId },
              data: {
                balance: {
                  decrement: cancellationFeeAmount,
                },
              },
            });

            // Create transaction record for the penalty using RIDE_PAYMENT type with negative amount
            await tx.transaction.create({
              data: {
                amount: -cancellationFeeAmount, // Negative amount for deduction
                type: TransactionType.RIDE_PAYMENT, // Re-use existing type
                status: TransactionStatus.COMPLETED,
                senderId: rental.driverId, // Driver is the 'sender' of the penalty payment
                // receiverId: null, // Or admin/system ID if applicable
                rideId: rental.id,
                description: `Driver cancellation penalty for rental ${rental.id}`,
              },
            });
          }
        }
      }

      // Update the ride itself
      const updatedRental = await tx.ride.update({
        where: { id: rental.id },
        data: rideUpdateData,
      });

      return updatedRental;
    });

    // Send cancellation notifications to affected parties
    const cancelledByUser = req.user.userType === UserType.USER;
    const cancelledByDriver = req.user.userType === UserType.DRIVER;

    try {
      if (cancelledByUser && result.driverId) {
        // User cancelled - notify driver
        await sendNotificationToUser(
          result.driverId,
          "Booking Cancelled 😞",
          `The car rental booking has been cancelled by the customer.${reason ? ` Reason: ${reason}` : ""}`,
          "general",
          {
            rideId: result.id,
            cancelledBy: "user",
            reason: reason || "",
            status: "cancelled",
          }
        );
      } else if (cancelledByDriver) {
        // Driver cancelled - notify user
        await sendNotificationToUser(
          result.userId,
          "Booking Cancelled 😞",
          `Your car rental booking has been cancelled by the driver.${reason ? ` Reason: ${reason}` : ""}`,
          "general",
          {
            rideId: result.id,
            cancelledBy: "driver",
            reason: reason || "",
            status: "cancelled",
          }
        );
      }
    } catch (notificationError) {
      console.error(
        "Failed to send cancellation notification:",
        notificationError
      );
      // Don't fail the cancellation due to notification error
    }

    return res.json(result);
  } catch (error: any) {
    console.error("Error cancelling rental:", error);
    // Check for specific error messages thrown from the transaction
    if (error.message === "Rental not found or cannot be cancelled") {
      return res.status(404).json({ error: error.message });
    }
    // Note: We are not throwing the insufficient funds error anymore, just logging.
    // if (error.message === "Driver has insufficient funds to cover cancellation fee.") {
    //    return res.status(400).json({ error: error.message });
    // }
    return res.status(500).json({ error: "Failed to cancel rental" });
  }
};

// Driver requests to end rental
export const requestEndRental = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { endOdometer } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        driverId: req.user.userId,
        status: RideStatus.RIDE_STARTED,
      },
      include: {
        locationLogs: {
          orderBy: { timestamp: "asc" },
        },
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Active rental not found" });
    }

    // Calculate actual duration
    const startTime = rental.rideStartedAt!;
    const endTime = new Date();
    const actualMinutes = Math.ceil(
      (endTime.getTime() - startTime.getTime()) / (1000 * 60)
    );

    // Calculate actual distance using odometer readings
    const actualKms = endOdometer - rental.startOdometer!;

    // Validate distance with GPS logs
    let gpsDistance = 0;
    const logs = rental.locationLogs;

    for (let i = 1; i < logs.length; i++) {
      const prevLog = logs[i - 1];
      const currentLog = logs[i];

      const segmentDistance = await calculateDistance(
        `${prevLog.latitude},${prevLog.longitude}`,
        `${currentLog.latitude},${currentLog.longitude}`
      );
      gpsDistance += segmentDistance;
    }

    // Use GPS distance if odometer reading seems incorrect (±20% difference)
    const finalDistance =
      Math.abs(actualKms - gpsDistance) > actualKms * 0.2
        ? gpsDistance
        : actualKms;

    // Calculate extra charges
    const packageKms = rental.rentalPackageKms || 0;
    const extraKms = Math.max(0, finalDistance - packageKms);
    const extraMinutes = Math.max(
      0,
      actualMinutes - (rental.rentalPackageHours || 0) * 60
    );

    const extraKmCharges = Math.round(
      extraKms *
        EXTRA_KM_RATES[rental.carCategory as keyof typeof EXTRA_KM_RATES]
    );
    const extraMinuteCharges = Math.round(extraMinutes * EXTRA_MINUTE_RATE);

    // Include waiting charges
    const waitingCharges = rental.waitingCharges || 0;

    // Include carrier charge in the breakdown but not in additional calculation since it's already in base price
    const carrierCharge = rental.carrierCharge || 0;
    const basePrice = (rental.rentalBasePrice || 0) - carrierCharge;
    const totalAmount =
      basePrice +
      extraKmCharges +
      extraMinuteCharges +
      waitingCharges +
      carrierCharge;

    if (rental.paymentMode === PaymentMode.CASH) {
      // Update rental status to wait for driver's cash confirmation
      const updatedRental = await prisma.ride.update({
        where: { id },
        data: {
          endOdometer,
          actualKmsTravelled: finalDistance,
          actualMinutes,
          extraKmCharges,
          extraMinuteCharges,
          totalAmount,
          status: RideStatus.PAYMENT_PENDING,
        },
      });

      return res.json({
        success: true,
        rental: updatedRental,
        message: "Waiting for cash payment confirmation",
        charges: {
          basePrice: basePrice,
          carrierCharge: carrierCharge,
          extraKmCharges,
          extraMinuteCharges,
          waitingCharges, // Include waiting charges in the breakdown
          totalAmount,
        },
      });
    } else {
      // For online payment, create Razorpay order with shorter receipt ID
      const order = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        receipt: `r_${rental.id.slice(-12)}`, // Shortened receipt ID
        notes: {
          rentalId: rental.id,
          userId: rental.userId,
          driverId: rental.driverId,
        },
      });

      // Update rental with payment details
      const updatedRental = await prisma.ride.update({
        where: { id },
        data: {
          endOdometer,
          actualKmsTravelled: finalDistance,
          actualMinutes,
          extraKmCharges,
          extraMinuteCharges,
          totalAmount,
          status: RideStatus.PAYMENT_PENDING,
          razorpayOrderId: order.id,
          rideEndedAt: new Date(), // Add this to mark ride end time
        },
      });

      // Create pending transaction
      const transaction = await prisma.transaction.create({
        data: {
          amount: totalAmount,
          type: TransactionType.RENTAL_PAYMENT,
          status: TransactionStatus.PENDING,
          senderId: rental.userId,
          receiverId: rental.driverId!,
          rideId: rental.id,
          razorpayOrderId: order.id,
        },
      });

      return res.json({
        success: true,
        rental: updatedRental,
        transaction,
        razorpayOrder: {
          orderId: order.id,
          amount: totalAmount,
        },
        charges: {
          basePrice: basePrice,
          carrierCharge: carrierCharge,
          extraKmCharges,
          extraMinuteCharges,
          waitingCharges, // Include waiting charges in the breakdown
          totalAmount,
        },
      });
    }
  } catch (error) {
    console.error("Error ending rental:", error);
    return res.status(500).json({ error: "Failed to end rental" });
  }
};

// Driver confirms cash payment
export const confirmCashPayment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { received } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Fetch rental including metadata to check for applied fee
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        driverId: req.user.userId,
        status: RideStatus.PAYMENT_PENDING,
        paymentMode: PaymentMode.CASH,
      },
      select: {
        id: true,
        userId: true,
        driverId: true,
        totalAmount: true,
        metadata: true,
      },
    });

    if (!rental) {
      return res.status(404).json({
        error:
          "Rental not found or in incorrect state for cash payment confirmation",
      });
    }

    // Check if an outstanding fee was applied (before the transaction)
    console.log("Fetched rental metadata for payment:", rental.metadata);
    const metadata = rental.metadata as Prisma.JsonObject | null;
    const appliedFee = metadata?.appliedOutstandingFee;
    console.log("Applied fee detected:", appliedFee);
    const feeWasApplied = typeof appliedFee === "number" && appliedFee > 0;
    console.log("Fee was applied flag:", feeWasApplied);
    const userIdToResetFee = feeWasApplied ? rental.userId : null;

    if (!received) {
      return res.json({
        success: false,
        message: "Payment not received, rental remains active",
        rental: {
          id: rental.id,
          status: RideStatus.PAYMENT_PENDING,
        },
      });
    }

    // --- Main Transaction: Update Ride, Create Transaction, Update Wallet --- START
    const [updatedRental, transaction] = await prisma.$transaction([
      // 1. Update Ride Status
      prisma.ride.update({
        where: { id },
        data: {
          status: RideStatus.PAYMENT_COMPLETED,
          rideEndedAt: new Date(),
          paymentStatus: TransactionStatus.COMPLETED,
        },
      }),
      // 2. Create Transaction Record
      prisma.transaction.create({
        data: {
          amount: rental.totalAmount!,
          type: TransactionType.RENTAL_PAYMENT,
          status: TransactionStatus.COMPLETED,
          senderId: rental.userId,
          receiverId: rental.driverId!,
          rideId: rental.id,
          description: "Cash payment for car rental",
        },
      }),
      // 3. Update Driver Wallet
      prisma.wallet.upsert({
        where: {
          userId: rental.driverId!,
        },
        create: {
          userId: rental.driverId!,
          balance: rental.totalAmount!,
        },
        update: {
          balance: {
            increment: rental.totalAmount!,
          },
        },
      }),
    ]);
    // --- Main Transaction --- END

    // --- Separate Step: Reset User Fee if Applicable --- START
    if (userIdToResetFee) {
      try {
        await prisma.user.update({
          where: { id: userIdToResetFee },
          data: { outstandingCancellationFee: 0 }, // Reset the fee
        });
        console.log(
          `Outstanding cancellation fee reset for user ${userIdToResetFee} after rental ${rental.id} cash payment.`
        );
      } catch (userUpdateError) {
        // Log error if fee reset fails, but don't fail the overall request
        console.error(
          `Failed to reset outstanding fee for user ${userIdToResetFee} after successful cash payment for rental ${rental.id}:`,
          userUpdateError
        );
      }
    }
    // --- Separate Step: Reset User Fee if Applicable --- END

    // Send payment success notifications
    try {
      await sendNotificationToUser(
        rental.userId,
        "Payment Completed! ✅",
        `Your car rental payment of ₹${rental.totalAmount} has been completed successfully. Thank you for using our service!`,
        "payment_success",
        {
          rideId: rental.id,
          amount: rental.totalAmount!.toString(),
          paymentMethod: "cash",
          status: "completed",
        }
      );
    } catch (notificationError) {
      console.error(
        "Failed to send payment completion notification:",
        notificationError
      );
    }

    return res.json({
      success: true,
      message:
        "Payment confirmed and rental completed" +
        (feeWasApplied ? " (Outstanding fee cleared)." : "."),
      rental: updatedRental,
      transaction,
    });
  } catch (error) {
    console.error("Error confirming payment:", error);
    // Handle potential errors from the main transaction
    return res.status(500).json({ error: "Failed to confirm payment" });
  }
};

// Verify Razorpay payment
export const verifyRazorpayPayment = async (req: Request, res: Response) => {
  const { id } = req.params; // This is the rideId
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing Razorpay payment details" });
  }

  try {
    // Verify payment signature first
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Fetch the rental including metadata and necessary IDs
    const rental = await prisma.ride.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        driverId: true,
        totalAmount: true,
        metadata: true,
        status: true,
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }
    if (rental.status !== RideStatus.PAYMENT_PENDING) {
      console.warn(
        `Razorpay verification attempted for rental ${id} not in PAYMENT_PENDING state (state: ${rental.status})`
      );
      if (rental.status === RideStatus.PAYMENT_COMPLETED) {
        return res.json({
          success: true,
          message: "Payment already verified.",
          rental,
        });
      }
      return res.status(400).json({
        error: `Rental is not awaiting payment (current status: ${rental.status})`,
      });
    }

    // Check if an outstanding fee was applied (before the transaction)
    console.log("Fetched rental metadata for payment:", rental.metadata);
    const metadata = rental.metadata as Prisma.JsonObject | null;
    const appliedFee = metadata?.appliedOutstandingFee;
    console.log("Applied fee detected:", appliedFee);
    const feeWasApplied = typeof appliedFee === "number" && appliedFee > 0;
    console.log("Fee was applied flag:", feeWasApplied);
    const userIdToResetFee = feeWasApplied ? rental.userId : null;

    // Perform main transaction: Update Ride, Transaction, Wallet
    // Destructure results directly, type inference should work here for these 3 operations
    const [updatedRental, paymentUpdateResult, walletUpdateResult] =
      await prisma.$transaction([
        prisma.ride.update({
          where: { id: rental.id },
          data: {
            status: RideStatus.PAYMENT_COMPLETED,
            rideEndedAt: new Date(),
            paymentStatus: TransactionStatus.COMPLETED,
          },
        }),
        prisma.transaction.updateMany({
          where: {
            rideId: rental.id,
            razorpayOrderId: razorpay_order_id,
            status: TransactionStatus.PENDING,
          },
          data: {
            status: TransactionStatus.COMPLETED,
            razorpayPaymentId: razorpay_payment_id,
            description: "Online payment for car rental",
          },
        }),
        prisma.wallet.upsert({
          where: { userId: rental.driverId! },
          create: {
            userId: rental.driverId!,
            balance: rental.totalAmount!,
          },
          update: {
            balance: {
              increment: rental.totalAmount!,
            },
          },
        }),
      ]);

    // If the main transaction succeeded AND a fee was applied, reset the user's fee
    if (userIdToResetFee) {
      try {
        await prisma.user.update({
          where: { id: userIdToResetFee },
          data: { outstandingCancellationFee: 0 },
        });
        console.log(
          `Outstanding cancellation fee reset for user ${userIdToResetFee} after rental ${rental.id} Razorpay payment.`
        );
      } catch (userUpdateError) {
        // Log error if fee reset fails, but don't fail the overall request
        console.error(
          `Failed to reset outstanding fee for user ${userIdToResetFee} after successful payment for rental ${rental.id}:`,
          userUpdateError
        );
      }
    }

    // Send payment success notifications
    try {
      await sendNotificationToUser(
        rental.userId,
        "Payment Completed! ✅",
        `Your car rental payment of ₹${rental.totalAmount} has been completed successfully. Thank you for using our service!`,
        "payment_success",
        {
          rideId: rental.id,
          amount: rental.totalAmount!.toString(),
          paymentMethod: "online",
          razorpayPaymentId: razorpay_payment_id,
          status: "completed",
        }
      );
    } catch (notificationError) {
      console.error(
        "Failed to send payment completion notification:",
        notificationError
      );
    }

    return res.json({
      success: true,
      message:
        "Payment verified and rental completed" +
        (feeWasApplied ? " (Outstanding fee cleared)." : "."),
      rental: updatedRental, // Return the updated rental object from the transaction result
      // Optional: include other results if needed by frontend
      // transactionUpdateCount: paymentUpdateResult.count,
      // walletInfo: walletUpdateResult
    });
  } catch (error) {
    console.error("Error verifying Razorpay payment:", error);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
};
