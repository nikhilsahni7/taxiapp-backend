// routes/wallet.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import { verifyToken } from "../middlewares/auth";
import {
  initiateTopUp,
  requestWithdrawal,
} from "../controllers/walletController";

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

    // Get regular transactions
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

    // Get long distance transactions
    const longDistanceTransactions =
      await prisma.longDistanceTransaction.findMany({
        where: {
          OR: [{ senderId: driverId }, { receiverId: driverId }],
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          booking: {
            select: {
              pickupLocation: true,
              dropLocation: true,
              totalAmount: true,
              serviceType: true,
              tripType: true,
              status: true,
            },
          },
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
      longDistanceTransactions: longDistanceTransactions.map((tx) => ({
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        status: tx.status,
        description: tx.description,
        createdAt: tx.createdAt,
        bookingDetails: tx.booking
          ? {
              pickup: tx.booking.pickupLocation,
              drop: tx.booking.dropLocation,
              totalAmount: tx.booking.totalAmount,
              serviceType: tx.booking.serviceType,
              tripType: tx.booking.tripType,
              bookingStatus: tx.booking.status,
            }
          : null,
        paymentId: tx.razorpayPaymentId,
        orderId: tx.razorpayOrderId,
        metadata: tx.metadata,
      })),
    });
  } catch (error) {
    console.error("Error fetching wallet details:", error);
    res.status(500).json({ error: "Failed to fetch wallet details" });
  }
});

// Payment success webhook/callback
router.post("/payment-success", verifyToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;
    const driverId = req.user?.userId;

    // Find the pending transaction
    const transaction = await prisma.transaction.findFirst({
      where: {
        razorpayOrderId: orderId,
        status: "PENDING",
        senderId: driverId,
      },
    });

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Update transaction status
    await prisma.$transaction([
      // Update transaction
      prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: "COMPLETED",
          razorpayPaymentId: paymentId,
          metadata: {
            signature,
            paymentId,
          },
        },
      }),
      // Update wallet balance
      prisma.wallet.update({
        where: { userId: driverId },
        data: {
          balance: {
            increment: transaction.amount,
          },
        },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error("Error processing payment success:", error);
    res.status(500).json({ error: "Failed to process payment" });
  }
});

router.post("/topup", verifyToken, initiateTopUp);
router.post("/withdraw", verifyToken, requestWithdrawal);

export { router as walletRouter };
