// routes/wallet.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();

// Get wallet balance and transactions
router.get("/driver-wallet", verifyToken, async (req, res) => {
  try {
    const driverId = req.user?.userId;

    if (!driverId) {
      return res.status(401).json({ error: "Driver ID not found" });
    }

    // Get wallet details
    const wallet = await prisma.wallet.findUnique({
      where: { userId: driverId },
    });

    // Get transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ senderId: driverId }, { receiverId: driverId }],
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        ride: true,
      },
    });

    res.json({
      balance: wallet?.balance || 0,
      currency: wallet?.currency || "INR",
      transactions: transactions.map((tx) => ({
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        status: tx.status,
        description: tx.description,
        createdAt: tx.createdAt,
        rideDetails: tx.ride
          ? {
              pickup: tx.ride.pickupLocation,
              drop: tx.ride.dropLocation,
              fare: tx.ride.fare,
            }
          : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching wallet details:", error);
    res.status(500).json({ error: "Failed to fetch wallet details" });
  }
});

export { router as walletRouter };
