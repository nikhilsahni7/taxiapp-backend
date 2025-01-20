import express from "express";
import {
  getAllRidesData,
  getDetailedStats,
  getPendingWithdrawals,
  handleWithdrawal,
} from "../controllers/adminController";
import { verifyAdmin } from "../middlewares/auth";

const router = express.Router();

// Comprehensive data endpoints
router.get("/rides/all", verifyAdmin, getAllRidesData);
router.get("/stats", verifyAdmin, getDetailedStats);

// Withdrawal management
router.get("/withdrawals", verifyAdmin, getPendingWithdrawals);
router.post("/withdrawals/:transactionId", verifyAdmin, handleWithdrawal);

export { router as adminRouter };
