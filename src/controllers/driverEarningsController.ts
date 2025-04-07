import { PrismaClient, RideStatus } from "@prisma/client";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import type { Request, Response } from "express";

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
  // Use a more reliable method to get IST time
  const now = new Date();
  // IST is UTC+5:30
  const utcTime = now.getTime();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5.5 hours in milliseconds
  return new Date(utcTime + istOffset);
}

// Helper function to convert UTC to IST
function utcToIST(date: Date): Date {
  if (!date) return date;
  // IST is UTC+5:30
  const utcTime = date.getTime();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5.5 hours in milliseconds
  return new Date(utcTime + istOffset);
}

// Helper function to convert IST to UTC
function istToUTC(date: Date): Date {
  if (!date) return date;
  // IST is UTC+5:30
  const istTime = date.getTime();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5.5 hours in milliseconds
  return new Date(istTime - istOffset);
}

// Get current day's earnings
export const getCurrentDayEarnings = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get current IST date
    const istDate = getISTDateTime();
    console.log(`Current IST Date: ${istDate.toISOString()}`);

    // Get start and end of IST day (midnight to midnight)
    const istStartOfDay = startOfDay(istDate);
    const istEndOfDay = endOfDay(istDate);

    console.log(
      `IST day range: ${istStartOfDay.toISOString()} to ${istEndOfDay.toISOString()}`
    );

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

    // Get all completed rides that ended on the current IST day
    const completedRides = await prisma.ride.findMany({
      where: {
        driverId: req.user.userId,
        status: {
          in: [RideStatus.PAYMENT_COMPLETED, RideStatus.RIDE_ENDED],
        },
        // Need to carefully consider all cases when a ride might be considered part of today's earnings
        OR: [
          // Rides completed today based on ride end time
          {
            rideEndedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
          // Rides that received payment today
          {
            status: RideStatus.PAYMENT_COMPLETED,
            updatedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
          // Rides that ended today but might not have set rideEndedAt
          {
            status: RideStatus.RIDE_ENDED,
            updatedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
        ],
      },
    });

    console.log(
      `Found ${completedRides.length} completed rides for today's earnings`
    );

    // If debugging needed, log the ride details
    completedRides.forEach((ride, index) => {
      console.log(`Ride ${index + 1}:`, {
        id: ride.id,
        status: ride.status,
        createdAt: ride.createdAt,
        updatedAt: ride.updatedAt,
        rideEndedAt: ride.rideEndedAt,
        totalAmount: ride.totalAmount,
        extraCharges: ride.extraCharges,
        isCarRental: ride.isCarRental,
      });
    });

    const earnings = {
      totalEarnings: 0,
      totalTrips: completedRides.length,
      localRides: {
        count: 0,
        earnings: 0,
      },
      rentalRides: {
        count: 0,
        earnings: 0,
      },
    };

    // Process each ride to calculate earnings
    completedRides.forEach((ride) => {
      // Calculate full amount including extras
      const amount = (ride.totalAmount || 0) + (ride.extraCharges || 0);

      // Categorize by ride type
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
          rideCount: completedRides.length,
          serverTime: new Date().toISOString(),
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
    console.log(`Current IST Date for history: ${istDate.toISOString()}`);

    // Get end of current IST day
    const istEndOfDay = endOfDay(istDate);

    // Get start of 30 days ago in IST
    const istStartDate = startOfDay(subDays(istDate, 30));

    console.log(
      `History date range: ${istStartDate.toISOString()} to ${istEndOfDay.toISOString()}`
    );

    // Convert to UTC for database query
    const utcStartDate = istToUTC(istStartDate);
    const utcEndDate = istToUTC(istEndOfDay);

    console.log("History timestamp ranges:", {
      istStartDate: istStartDate.toISOString(),
      istEndOfDay: istEndOfDay.toISOString(),
      utcStartDate: utcStartDate.toISOString(),
      utcEndDate: utcEndDate.toISOString(),
    });

    // Get all completed rides in the last 30 days (IST time)
    const rides = await prisma.ride.findMany({
      where: {
        driverId: req.user.userId,
        status: {
          in: [RideStatus.PAYMENT_COMPLETED, RideStatus.RIDE_ENDED],
        },
        OR: [
          // Rides completed based on ride end time
          {
            rideEndedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
          // Rides that received payment in this period
          {
            status: RideStatus.PAYMENT_COMPLETED,
            updatedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
          // Rides that ended but might not have set rideEndedAt
          {
            status: RideStatus.RIDE_ENDED,
            updatedAt: {
              gte: utcStartDate,
              lte: utcEndDate,
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc", // Most recent first
      },
    });

    console.log(`Found ${rides.length} rides for earnings history`);

    // Group earnings by IST date
    const earningsByDate = new Map<string, DailyEarnings>();

    rides.forEach((ride) => {
      // Determine the completion date in IST (when money was earned)
      // Prefer rideEndedAt as it's the most accurate timestamp for completion
      const completionDate = ride.rideEndedAt || ride.updatedAt;

      // Convert to IST timezone for date grouping
      const istRideDate = utcToIST(completionDate);
      const rideDate = format(istRideDate, "yyyy-MM-dd");

      // Create the date entry if it doesn't exist
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
      const amount = (ride.totalAmount || 0) + (ride.extraCharges || 0);

      // Categorize earnings by ride type
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

    // Return grouped earnings data as an array sorted by date (newest first)
    const sortedEarnings = Array.from(earningsByDate.values()).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return res.json({
      success: true,
      data: sortedEarnings,
      debug: {
        timezone: "Asia/Kolkata",
        serverTime: new Date().toISOString(),
        istTime: getISTDateTime().toISOString(),
        totalRidesFound: rides.length,
      },
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
  // Convert input dates from IST to UTC for database query
  const utcStartDate = istToUTC(startDate);
  const utcEndDate = istToUTC(endDate);

  const rides = await prisma.ride.findMany({
    where: {
      driverId,
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

  return earnings;
}
