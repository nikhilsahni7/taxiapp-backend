import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Get total rides (local and outstation)
export const getTotalRides = async (req: Request, res: Response) => {
  try {
    const totalRides = await prisma.ride.count();
    const localRides = await prisma.ride.count({
      where: { rideType: "LOCAL" },
    });
    const outstationRides = await prisma.ride.count({
      where: { rideType: "OUTSTATION" },
    });

    res.json({
      totalRides,
      localRides,
      outstationRides,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch ride data" });
  }
};

// Get active rides (rides that are not completed or cancelled)
export const getActiveRides = async (req: Request, res: Response) => {
  try {
    const activeRides = await prisma.ride.findMany({
      where: {
        status: {
          notIn: ["PAYMENT_COMPLETED", "CANCELLED"],
        },
      },
      include: {
        user: true,
        driver: true,
      },
    });

    res.json(activeRides);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch active rides" });
  }
};

// Get long-distance rides by service type (outstation, hill station, etc.)
export const getLongDistanceRides = async (req: Request, res: Response) => {
  try {
    const outstationRides = await prisma.longDistanceBooking.count({
      where: { serviceType: "OUTSTATION" },
    });
    const hillStationRides = await prisma.longDistanceBooking.count({
      where: { serviceType: "HILL_STATION" },
    });
    const chardhamYatraRides = await prisma.longDistanceBooking.count({
      where: { serviceType: "CHARDHAM_YATRA" },
    });
    const allIndiaTourRides = await prisma.longDistanceBooking.count({
      where: { serviceType: "ALL_INDIA_TOUR" },
    });

    res.json({
      outstationRides,
      hillStationRides,
      chardhamYatraRides,
      allIndiaTourRides,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch long-distance rides" });
  }
};

// Get total drivers and their details
export const getTotalDrivers = async (req: Request, res: Response) => {
  try {
    const totalDrivers = await prisma.user.count({
      where: { userType: "DRIVER" },
    });
    const drivers = await prisma.user.findMany({
      where: { userType: "DRIVER" },
      include: { driverDetails: true },
    });

    res.json({
      totalDrivers,
      drivers,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch driver data" });
  }
};

// Get total users and their details
export const getTotalUsers = async (req: Request, res: Response) => {
  try {
    const totalUsers = await prisma.user.count({
      where: { userType: "USER" },
    });
    const users = await prisma.user.findMany({
      where: { userType: "USER" },
      include: { userDetails: true },
    });

    res.json({
      totalUsers,
      users,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user data" });
  }
};

// Get total vendors and their details
export const getTotalVendors = async (req: Request, res: Response) => {
  try {
    const totalVendors = await prisma.user.count({
      where: { userType: "VENDOR" },
    });
    const vendors = await prisma.user.findMany({
      where: { userType: "VENDOR" },
      include: { vendorDetails: true },
    });

    res.json({
      totalVendors,
      vendors,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch vendor data" });
  }
};

// Get total wallet balances of all users
export const getTotalWalletBalances = async (req: Request, res: Response) => {
  try {
    const wallets = await prisma.wallet.findMany({
      include: { user: true },
    });

    const totalBalance = wallets.reduce(
      (sum, wallet) => sum + wallet.balance,
      0
    );

    res.json({
      totalBalance,
      wallets,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch wallet data" });
  }
};

// Get all pending withdrawals
export const getPendingWithdrawals = async (req: Request, res: Response) => {
  try {
    const withdrawals = await prisma.transaction.findMany({
      where: {
        type: "WITHDRAWAL",
        status: "PENDING",
      },
      include: {
        sender: true,
      },
    });

    res.json(withdrawals);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
};

// Handle withdrawal approval/rejection
export const handleWithdrawal = async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;
    const { action, reason } = req.body;

    const transaction = await prisma.$transaction(async (prisma) => {
      const withdrawal = await prisma.transaction.findUnique({
        where: { id: transactionId },
        include: { sender: true },
      });

      if (!withdrawal) {
        throw new Error("Withdrawal not found");
      }

      if (action === "APPROVE") {
        return await prisma.transaction.update({
          where: { id: transactionId },
          data: { status: "COMPLETED" },
        });
      } else {
        // Reject: Refund the amount
        const updated = await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            status: "FAILED",
            metadata: {
              ...((withdrawal.metadata as object) || {}),
              rejectionReason: reason,
            },
          },
        });

        // Refund to wallet
        await prisma.wallet.update({
          where: { userId: withdrawal.senderId! },
          data: {
            balance: { increment: withdrawal.amount },
          },
        });

        return updated;
      }
    });

    res.json({
      success: true,
      transaction,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process withdrawal" });
  }
};
