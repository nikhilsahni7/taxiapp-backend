import { PrismaClient } from "@prisma/client";
import express from "express";
import {
  getUserWalletDetails,
  initiateUserTopUp,
  requestUserWithdrawal,
} from "../controllers/userWalletController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();

// Get user wallet balance and transactions
router.get("/wallet", verifyToken, getUserWalletDetails);

// User initiates wallet top-up
router.post("/user-topup", verifyToken, initiateUserTopUp);

// User requests withdrawal
router.post("/user-withdraw", verifyToken, requestUserWithdrawal);

// Payment success webhook/callback for user
router.post("/user-payment-success", verifyToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;
    const userId = req.user?.userId;

    // Find the pending transaction
    const transaction = await prisma.transaction.findFirst({
      where: {
        razorpayOrderId: orderId,
        status: "PENDING",
        senderId: userId,
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
        where: { userId: userId },
        data: {
          balance: {
            increment: transaction.amount,
          },
        },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error("Error processing user payment success:", error);
    res.status(500).json({ error: "Failed to process payment" });
  }
});

export { router as userWalletRouter };
