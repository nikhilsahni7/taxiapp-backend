import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getDriverRideHistory = async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Get regular rides
    const regularRides = await prisma.ride.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        fare: true,
        distance: true,
        duration: true,
        totalAmount: true,
        paymentMode: true,
        paymentStatus: true,
        rideType: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get long distance rides
    const longDistanceRides = await prisma.longDistanceBooking.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        serviceType: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        distance: true,
        duration: true,
        startDate: true,
        endDate: true,
        totalAmount: true,
        advancePaymentStatus: true,
        finalPaymentStatus: true,
        finalPaymentMode: true,
        tripType: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get vendor rides
    const vendorRides = await prisma.vendorBooking.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        serviceType: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        distance: true,
        duration: true,
        startDate: true,
        endDate: true,
        driverPayout: true,
        tripType: true,
        createdAt: true,
        vendor: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get counts for pagination
    const [regularCount, longDistanceCount, vendorCount] = await Promise.all([
      prisma.ride.count({ where: { driverId } }),
      prisma.longDistanceBooking.count({ where: { driverId } }),
      prisma.vendorBooking.count({ where: { driverId } }),
    ]);

    // Calculate earnings
    const totalEarnings = await prisma.ride.aggregate({
      where: {
        driverId,
        paymentStatus: "COMPLETED",
        status: "RIDE_ENDED",
      },
      _sum: {
        totalAmount: true,
      },
    });

    const longDistanceEarnings = await prisma.longDistanceBooking.aggregate({
      where: {
        driverId,
        finalPaymentStatus: "COMPLETED",
      },
      _sum: {
        totalAmount: true,
      },
    });

    const vendorEarnings = await prisma.vendorBooking.aggregate({
      where: {
        driverId,
        status: "COMPLETED",
      },
      _sum: {
        driverPayout: true,
      },
    });

    const response = {
      regularRides: {
        rides: regularRides,
        total: regularCount,
      },
      longDistanceRides: {
        rides: longDistanceRides,
        total: longDistanceCount,
      },
      vendorRides: {
        rides: vendorRides,
        total: vendorCount,
      },
      earnings: {
        regularRides: totalEarnings._sum.totalAmount || 0,
        longDistanceRides: longDistanceEarnings._sum.totalAmount || 0,
        vendorRides: vendorEarnings._sum.driverPayout || 0,
        total:
          (totalEarnings._sum.totalAmount || 0) +
          (longDistanceEarnings._sum.totalAmount || 0) +
          (vendorEarnings._sum.driverPayout || 0),
      },
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(
          Math.max(regularCount, longDistanceCount, vendorCount) / Number(limit)
        ),
        limit: Number(limit),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching driver ride history:", error);
    res.status(500).json({ error: "Failed to fetch driver ride history" });
  }
};

// Get driver's current ride/booking
export const getDriverCurrentRide = async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;

    // Check regular rides
    const currentRegularRide = await prisma.ride.findFirst({
      where: {
        driverId,
        status: {
          in: ["ACCEPTED", "DRIVER_ARRIVED", "RIDE_STARTED", "PAYMENT_PENDING"],
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
      },
    });

    // Check long distance bookings
    const currentLongDistanceRide = await prisma.longDistanceBooking.findFirst({
      where: {
        driverId,
        status: {
          in: [
            "DRIVER_ACCEPTED",
            "DRIVER_PICKUP_STARTED",
            "DRIVER_ARRIVED",
            "STARTED",
          ],
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
      },
    });

    // Check vendor bookings
    const currentVendorRide = await prisma.vendorBooking.findFirst({
      where: {
        driverId,
        status: {
          in: ["DRIVER_ACCEPTED", "STARTED"],
        },
      },
      include: {
        vendor: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    const currentRide = {
      regularRide: currentRegularRide,
      longDistanceRide: currentLongDistanceRide,
      vendorRide: currentVendorRide,
    };

    res.json(currentRide);
  } catch (error) {
    console.error("Error fetching driver's current ride:", error);
    res.status(500).json({ error: "Failed to fetch driver's current ride" });
  }
};
