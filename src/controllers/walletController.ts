import type { Request, Response } from "express";
import {
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import Razorpay from "razorpay";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: "rzp_test_3e3y5c5TI1K7Lz",
  key_secret: "2XzYAvwfuR1V6JXFK6ts6kU2", // test keys
});
// Driver initiates wallet top-up
export const initiateTopUp = async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;

    const driverId = (req as any).user?.userId;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `topup_${Date.now()}`,
    });

    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WALLET_TOPUP,
        status: TransactionStatus.PENDING,
        senderId: driverId,
        razorpayOrderId: order.id,
        description: "Wallet top-up",
      },
    });

    res.json({
      orderId: order.id,
      amount,
      transactionId: transaction.id,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to initiate top-up" });
  }
};

// Driver requests withdrawal
export const requestWithdrawal = async (req: Request, res: Response) => {
  try {
    const { amount, bankDetails } = req.body;
    const driverId = (req as any).user?.userId;

    // Check wallet balance
    const wallet = await prisma.wallet.findUnique({
      where: { userId: driverId },
    });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.PENDING,
        senderId: driverId,
        description: "Withdrawal request",
        metadata: { bankDetails },
      },
    });

    res.json({
      success: true,
      transactionId: transaction.id,
      status: "PENDING",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process withdrawal request" });
  }
};
