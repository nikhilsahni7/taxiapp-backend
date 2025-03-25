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
  // Create a direct IST date using the timezone offset
  const now = new Date();

  // For direct IST time calculation
  const istTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  return istTime;
}

// Helper function to convert UTC to IST
function utcToIST(date: Date): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

// Helper function to convert IST to UTC
function istToUTC(date: Date): Date {
  // Get ISO string components for the IST date
  const istYear = date.getFullYear();
  const istMonth = date.getMonth();
  const istDay = date.getDate();
  const istHours = date.getHours();
  const istMinutes = date.getMinutes();
  const istSeconds = date.getSeconds();

  // Create a string representation in ISO format with IST offset
  const istDateString = new Date(
    istYear,
    istMonth,
    istDay,
    istHours,
    istMinutes,
    istSeconds
  ).toLocaleString("en-US", {
    timeZone: "UTC",
  });

  return new Date(istDateString);
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
