import type { Request, Response } from "express";
import { PrismaClient, TransactionStatus } from "@prisma/client";

const prisma = new PrismaClient();

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
          data: { status: TransactionStatus.COMPLETED },
        });
      } else {
        // Reject: Refund the amount
        const updated = await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            status: TransactionStatus.FAILED,
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
