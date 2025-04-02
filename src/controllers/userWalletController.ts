import {
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import type { Request, Response } from "express";
import Razorpay from "razorpay";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_3e3y5c5TI1K7Lz",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "2XzYAvwfuR1V6JXFK6ts6kU2",
});

/**
 * @description Initiates a wallet top-up for a regular user.
 * @param {Request} req - Express request object, expects { amount: number } in body.
 * @param {Response} res - Express response object.
 */
export const initiateUserTopUp = async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount specified" });
    }

    await prisma.wallet.upsert({
      where: { userId: userId },
      update: {},
      create: { userId: userId, balance: 0, currency: "INR" },
    });

    const orderOptions = {
      amount: Math.round(amount * 100), // Amount in paise
      currency: "INR",
      receipt: `user_topup_${userId}_${Date.now()}`,
      notes: {
        userId: userId,
        type: "WALLET_TOPUP",
      },
    };

    const order = await razorpay.orders.create(orderOptions);

    // Create a pending transaction record
    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WALLET_TOPUP,
        status: TransactionStatus.PENDING,
        senderId: userId, // User is the sender in a top-up context
        receiverId: userId, // Represents money going into the user's wallet
        razorpayOrderId: order.id,
        description: "User wallet top-up",
        metadata: { userId },
      },
    });

    res.json({
      orderId: order.id,
      amount,
      currency: "INR",
      transactionId: transaction.id,
    });
  } catch (error) {
    console.error("User top-up initiation error:", error);
    res.status(500).json({ error: "Failed to initiate user wallet top-up" });
  }
};

/**
 * @description Handles the request for a user to withdraw funds (if functionality is desired).
 * @param {Request} req - Express request object, expects { amount: number, bankDetails: object } in body.
 * @param {Response} res - Express response object.
 */
export const requestUserWithdrawal = async (req: Request, res: Response) => {
  try {
    const { amount, bankDetails } = req.body;
    const userId = (req as any).user?.userId; // Assuming verifyToken middleware adds user info

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount specified" });
    }
    if (!bankDetails) {
      return res
        .status(400)
        .json({ error: "Bank details are required for withdrawal" });
    }

    // Check wallet balance
    const wallet = await prisma.wallet.findUnique({
      where: { userId: userId },
    });

    if (!wallet || wallet.balance < amount) {
      return res
        .status(400)
        .json({ error: "Insufficient balance for withdrawal" });
    }

    // Create a pending withdrawal transaction
    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.PENDING,
        senderId: userId,
        description: "User withdrawal request",
        metadata: { bankDetails, userId }, // Store bank details securely
      },
    });

    // Optionally, decrease the balance immediately or wait for admin approval
    // For now, we just record the request. Balance update would happen upon approval.
    /*
     await prisma.wallet.update({
         where: { userId: userId },
         data: { balance: { decrement: amount } },
     });
     */

    res.json({
      success: true,
      message: "Withdrawal request submitted successfully.",
      transactionId: transaction.id,
      status: "PENDING",
    });
  } catch (error) {
    console.error("User withdrawal request error:", error);
    res
      .status(500)
      .json({ error: "Failed to process user withdrawal request" });
  }
};

/**
 * @description Gets user wallet balance and transactions.
 * @param {Request} req - Express request object.
 * @param {Response} res - Express response object.
 */
export const getUserWalletDetails = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // Get wallet details
    const wallet = await prisma.wallet.findUnique({
      where: { userId: userId },
    });

    // Get all user transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
      orderBy: {
        createdAt: "desc",
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
    });
  } catch (error) {
    console.error("Error fetching user wallet details:", error);
    res.status(500).json({ error: "Failed to fetch user wallet details" });
  }
};
