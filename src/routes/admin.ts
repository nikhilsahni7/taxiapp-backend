import express from "express";
import {
  getAllRidesData,
  getDetailedStats,
  getPendingWithdrawals,
  handleWithdrawal,
  getActiveLocalRidesStatus,
  getActiveLongDistanceRidesStatus,
  getActiveVendorRidesStatus,
} from "../controllers/adminController";
import { verifyAdmin } from "../middlewares/auth";

const router = express.Router();

// Comprehensive data endpoints
router.get("/rides/all", verifyAdmin, getAllRidesData);
router.get("/stats", verifyAdmin, getDetailedStats);

// Withdrawal management
router.get("/withdrawals", verifyAdmin, getPendingWithdrawals);
router.post("/withdrawals/:transactionId", verifyAdmin, handleWithdrawal);

// Active rides status
router.get("/rides/active/local", verifyAdmin, getActiveLocalRidesStatus);
router.get(
  "/rides/active/long-distance",
  verifyAdmin,
  getActiveLongDistanceRidesStatus
);
router.get("/rides/active/vendor", verifyAdmin, getActiveVendorRidesStatus);

export { router as adminRouter };
