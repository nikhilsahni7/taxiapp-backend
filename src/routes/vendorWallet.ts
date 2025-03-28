import { PrismaClient } from "@prisma/client";
import express from "express";
import {
  initiateVendorTopUp,
  requestVendorWithdrawal,
} from "../controllers/vendorWalletController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();

// Get vendor wallet balance and transactions
router.get("/vendor-wallet", verifyToken, async (req, res) => {
  try {
    const vendorId = req.user?.userId;

    if (!vendorId) {
      return res.status(401).json({ error: "Vendor ID not found" });
    }

    // Get wallet details
    const wallet = await prisma.wallet.findUnique({
      where: { userId: vendorId },
    });

    // Get all vendor transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ senderId: vendorId }, { receiverId: vendorId }],
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get vendor booking transactions
    const vendorBookingTransactions =
      await prisma.vendorBookingTransaction.findMany({
        where: {
          OR: [{ senderId: vendorId }, { receiverId: vendorId }],
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          booking: {
            select: {
              pickupLocation: true,
              dropLocation: true,
              vendorPrice: true,
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
        paymentId: tx.razorpayPaymentId,
        orderId: tx.razorpayOrderId,
        metadata: tx.metadata,
      })),
      vendorBookingTransactions: vendorBookingTransactions.map((tx) => ({
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
              vendorPrice: tx.booking.vendorPrice,
              serviceType: tx.booking.serviceType,
              tripType: tx.booking.tripType,
              bookingStatus: tx.booking.status,
            }
          : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching vendor wallet details:", error);
    res.status(500).json({ error: "Failed to fetch vendor wallet details" });
  }
});

// Payment success webhook/callback for vendor
router.post("/vendor-payment-success", verifyToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;
    const vendorId = req.user?.userId;

    // Find the pending transaction
    const transaction = await prisma.transaction.findFirst({
      where: {
        razorpayOrderId: orderId,
        status: "PENDING",
        senderId: vendorId,
      },
    });

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Update transaction status and wallet balance
    await prisma.$transaction([
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
      prisma.wallet.update({
        where: { userId: vendorId },
        data: {
          balance: {
            increment: transaction.amount,
          },
        },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error("Error processing vendor payment success:", error);
    res.status(500).json({ error: "Failed to process payment" });
  }
});

router.post("/vendor-topup", verifyToken, initiateVendorTopUp);
router.post("/vendor-withdraw", verifyToken, requestVendorWithdrawal);

export { router as vendorWalletRouter };
