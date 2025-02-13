import type { Request, Response } from "express";
import { PrismaClient, RideStatus } from "@prisma/client";
import { startOfDay, endOfDay, format, subDays } from "date-fns";

const prisma = new PrismaClient();

interface DailyEarnings {
  date: string;
  totalEarnings: number;
  totalTrips: number;
  localRides: {
    count: number;
    earnings: number;
  };
  rentalRides: {
    count: number;
    earnings: number;
  };
}

// Helper function to get IST date with proper timezone offset
function getISTDateTime(): Date {
  // Create a date object with the current UTC time
  const now = new Date();

  // Get the UTC timestamp
  const utcTime = now.getTime();

  // Get the local timezone offset in minutes
  const localOffset = now.getTimezoneOffset();

  // IST offset is +5:30 (330 minutes)
  const istOffset = -330;

  // Calculate the total offset in milliseconds
  const totalOffset = (localOffset + istOffset) * 60 * 1000;

  // Create new date with IST time
  return new Date(utcTime + totalOffset);
}

// Helper function to convert UTC to IST
function utcToIST(date: Date): Date {
  const utcTime = date.getTime();
  const localOffset = date.getTimezoneOffset();
  const istOffset = -330; // IST is UTC+5:30 (330 minutes)
  const totalOffset = (localOffset + istOffset) * 60 * 1000;
  return new Date(utcTime + totalOffset);
}

// Helper function to convert IST to UTC
function istToUTC(date: Date): Date {
  const time = date.getTime();
  const localOffset = date.getTimezoneOffset();
  const istOffset = -330;
  const totalOffset = (localOffset + istOffset) * 60 * 1000;
  return new Date(time - totalOffset);
}

// Get current day's earnings
export const getCurrentDayEarnings = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get current IST date
    const istDate = getISTDateTime();

    // Get start and end of IST day
    const istStartOfDay = startOfDay(istDate);
    const istEndOfDay = endOfDay(istDate);

    // Convert to UTC for database query
    const utcStartDate = istToUTC(istStartOfDay);
    const utcEndDate = istToUTC(istEndOfDay);

    console.log("Debug timestamps:", {
      currentIST: istDate.toISOString(),
      istStartOfDay: istStartOfDay.toISOString(),
      istEndOfDay: istEndOfDay.toISOString(),
      utcStartDate: utcStartDate.toISOString(),
      utcEndDate: utcEndDate.toISOString(),
    });

    const rides = await prisma.ride.findMany({
      where: {
        driverId: req.user.userId,
        status: {
          in: [RideStatus.PAYMENT_COMPLETED, RideStatus.RIDE_ENDED],
        },
        createdAt: {
          gte: utcStartDate,
          lte: utcEndDate,
        },
      },
    });

    const earnings = {
      totalEarnings: 0,
      totalTrips: rides.length,
      localRides: {
        count: 0,
        earnings: 0,
      },
      rentalRides: {
        count: 0,
        earnings: 0,
      },
    };

    rides.forEach((ride) => {
      const amount = ride.totalAmount || 0;

      if (ride.isCarRental) {
        earnings.rentalRides.count++;
        earnings.rentalRides.earnings += amount;
      } else {
        earnings.localRides.count++;
        earnings.localRides.earnings += amount;
      }
      earnings.totalEarnings += amount;
    });

    return res.json({
      success: true,
      data: {
        ...earnings,
        date: format(istDate, "yyyy-MM-dd"),
        debug: {
          currentTime: istDate.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          timezone: "Asia/Kolkata",
        },
      },
    });
  } catch (error) {
    console.error("Error fetching current day earnings:", error);
    return res.status(500).json({ error: "Failed to fetch earnings" });
  }
};

// Get earnings history for last 30 days
export const getEarningsHistory = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get current IST date
    const istDate = getISTDateTime();

    // Get end of current IST day
    const istEndOfDay = endOfDay(istDate);

    // Get start of 30 days ago in IST
    const istStartDate = startOfDay(subDays(istDate, 30));

    // Convert to UTC for database query
    const utcStartDate = istToUTC(istStartDate);
    const utcEndDate = istToUTC(istEndOfDay);

    const rides = await prisma.ride.findMany({
      where: {
        driverId: req.user.userId,
        status: {
          in: [RideStatus.PAYMENT_COMPLETED, RideStatus.RIDE_ENDED],
        },
        createdAt: {
          gte: utcStartDate,
          lte: utcEndDate,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const earningsByDate = new Map<string, DailyEarnings>();

    rides.forEach((ride) => {
      // Convert ride creation time to IST
      const istRideDate = utcToIST(ride.createdAt);
      const rideDate = format(istRideDate, "yyyy-MM-dd");

      if (!earningsByDate.has(rideDate)) {
        earningsByDate.set(rideDate, {
          date: rideDate,
          totalEarnings: 0,
          totalTrips: 0,
          localRides: { count: 0, earnings: 0 },
          rentalRides: { count: 0, earnings: 0 },
        });
      }

      const dateEarnings = earningsByDate.get(rideDate)!;
      const amount = ride.totalAmount || 0;

      if (ride.isCarRental) {
        dateEarnings.rentalRides.count++;
        dateEarnings.rentalRides.earnings += amount;
      } else {
        dateEarnings.localRides.count++;
        dateEarnings.localRides.earnings += amount;
      }

      dateEarnings.totalTrips++;
      dateEarnings.totalEarnings += amount;
    });

    return res.json({
      success: true,
      data: Array.from(earningsByDate.values()),
    });
  } catch (error) {
    console.error("Error fetching earnings history:", error);
    return res.status(500).json({ error: "Failed to fetch earnings history" });
  }
};

// Helper function to calculate earnings for a date range
async function calculateEarningsForDateRange(
  driverId: string,
  startDate: Date,
  endDate: Date
): Promise<Omit<DailyEarnings, "date">> {
  const rides = await prisma.ride.findMany({
    where: {
      driverId,
      status: RideStatus.RIDE_ENDED || RideStatus.PAYMENT_COMPLETED,
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  const earnings = {
    totalEarnings: 0,
    totalTrips: rides.length,
    localRides: {
      count: 0,
      earnings: 0,
    },
    rentalRides: {
      count: 0,
      earnings: 0,
    },
  };

  rides.forEach((ride) => {
    const amount = ride.totalAmount || 0;
    if (ride.isCarRental) {
      earnings.rentalRides.count++;
      earnings.rentalRides.earnings += amount;
    } else {
      earnings.localRides.count++;
      earnings.localRides.earnings += amount;
    }
    earnings.totalEarnings += amount;
  });

  return earnings;
}
