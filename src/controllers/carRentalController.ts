import {
  CancelledBy,
  PaymentMode,
  Prisma,
  PrismaClient,
  RideStatus,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { searchAvailableDrivers } from "../lib/driverService";
import { getCoordinatesAndAddress } from "../lib/locationService";
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

// Create a new car rental booking
export const createCarRental = async (req: Request, res: Response) => {
  const { carCategory, packageHours, paymentMode } = req.body;
  let { pickupLocation, pickupLat, pickupLng } = req.body;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
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

    // Create rental booking with coordinates
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
        rentalBasePrice: packageDetails.price,
        dropLocation: "", // not needed for car rental
        otp: Math.floor(1000 + Math.random() * 9000).toString(),
      },
    });

    // Start driver search process
    const searchResult = await findDriversForRental(rental);

    return res.status(201).json({
      rental,
      searchResult,
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

    console.log(currentMetrics);

    return res.json({
      rental,
      currentMetrics,
    });
  } catch (error) {
    console.error("Error getting rental status:", error);
    return res.status(500).json({ error: "Failed to get rental status" });
  }
};

// End rental and calculate final charges

// Helper function to find available drivers
async function findDriversForRental(rental: any) {
  let currentRadius = 3;
  const maxRadius = 15;
  const attemptedDrivers = new Set<string>();

  while (currentRadius <= maxRadius) {
    const drivers = await searchAvailableDrivers(
      `${rental.pickupLat},${rental.pickupLng}`,
      currentRadius
    );
    const newDrivers = drivers.filter((d) => !attemptedDrivers.has(d.driverId));

    if (newDrivers.length > 0) {
      const metadata: Prisma.JsonObject = {
        availableDrivers: newDrivers.map((d) => ({
          driverId: d.driverId,
          distance: d.distance,
          status: "pending",
        })),
        expiresAt: new Date(Date.now() + 60000).toISOString(), // 60 seconds from now
      };

      await prisma.ride.update({
        where: { id: rental.id },
        data: { metadata },
      });

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
        expiresAt: metadata.expiresAt,
      };
    }

    currentRadius += 2;
  }

  return {
    success: false,
    message: "No drivers found",
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
      },
    });

    return res.json(updatedRental);
  } catch (error) {
    console.error("Error accepting rental:", error);
    return res.status(500).json({ error: "Failed to accept rental" });
  }
};

// Driver marks arrival at pickup
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
      },
    });

    return res.json(updatedRental);
  } catch (error) {
    console.error("Error marking driver arrival:", error);
    return res.status(500).json({ error: "Failed to mark driver arrival" });
  }
};

// Start ride with OTP verification and initial odometer reading
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

    // Create initial location log
    const driverStatus = await prisma.driverStatus.findUnique({
      where: { driverId: req.user.userId },
    });

    // Start the ride with initial readings
    const updatedRental = await prisma.ride.update({
      where: { id },
      data: {
        status: RideStatus.RIDE_STARTED,
        rideStartedAt: new Date(),
        startOdometer,
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
      },
    });

    return res.json({
      success: true,
      rental: updatedRental,
      message: "Ride started successfully with initial odometer reading",
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

  try {
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        OR: [{ userId: req.user.userId }, { driverId: req.user.userId }],
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
      return res
        .status(404)
        .json({ error: "Rental not found or cannot be cancelled" });
    }

    // Calculate cancellation fee based on status and user type
    let cancellationFee = 0;
    if (rental.status !== RideStatus.SEARCHING) {
      cancellationFee = rental.rentalBasePrice! * 0.1; // 10% of base price
    }

    const updatedRental = await prisma.ride.update({
      where: { id },
      data: {
        status: RideStatus.CANCELLED,
        cancellationReason: reason,
        cancellationFee,
        cancelledBy: req.user.userType as CancelledBy,
      },
    });

    return res.json(updatedRental);
  } catch (error) {
    console.error("Error cancelling rental:", error);
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

    const totalAmount =
      (rental.rentalBasePrice || 0) + extraKmCharges + extraMinuteCharges;

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
          basePrice: rental.rentalBasePrice,
          extraKmCharges,
          extraMinuteCharges,
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
          basePrice: rental.rentalBasePrice,
          extraKmCharges,
          extraMinuteCharges,
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
    const rental = await prisma.ride.findFirst({
      where: {
        id,
        driverId: req.user.userId,
        status: RideStatus.PAYMENT_PENDING,
        paymentMode: PaymentMode.CASH,
      },
    });

    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }

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

    // Complete the rental, create transaction, and update wallet in a transaction
    const [updatedRental, transaction] = await prisma.$transaction([
      prisma.ride.update({
        where: { id },
        data: {
          status: RideStatus.PAYMENT_COMPLETED,
          rideEndedAt: new Date(),
        },
      }),
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
      // Add wallet update
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

    return res.json({
      success: true,
      message: "Payment confirmed and rental completed",
      rental: updatedRental,
      transaction,
    });
  } catch (error) {
    console.error("Error confirming payment:", error);
    return res.status(500).json({ error: "Failed to confirm payment" });
  }
};

// Verify Razorpay payment
export const verifyRazorpayPayment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  try {
    // Verify payment signature using Razorpay docs
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Fetch the rental so we have access to driverId and totalAmount needed later
    const rental = await prisma.ride.findUnique({
      where: { id },
    });
    if (!rental) {
      return res.status(404).json({ error: "Rental not found" });
    }

    // Complete the rental, update transaction, and update wallet in a single transaction
    const [updatedRental, paymentUpdate, walletUpdate] =
      await prisma.$transaction([
        prisma.ride.update({
          where: { id },
          data: {
            status: RideStatus.PAYMENT_COMPLETED,
            rideEndedAt: new Date(),
            paymentStatus: TransactionStatus.COMPLETED,
          },
        }),
        prisma.transaction.updateMany({
          where: {
            rideId: id,
            razorpayOrderId: razorpay_order_id,
            status: TransactionStatus.PENDING,
          },
          data: {
            status: TransactionStatus.COMPLETED,
            razorpayPaymentId: razorpay_payment_id,
            description: "online payment for car rental",
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

    return res.json({
      success: true,
      message: "Payment verified and rental completed",
      rental: updatedRental,
      transaction: paymentUpdate,
      wallet: walletUpdate,
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
};
