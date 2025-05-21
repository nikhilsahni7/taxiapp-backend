import express from "express";
import {
  adjustWalletBalance,
  getActiveLocalRidesStatus,
  getActiveLongDistanceRidesStatus,
  getActiveVendorRidesStatus,
  getAllDriversForApproval,
  getAllRidesData,
  getAllUsers,
  getAllWalletsSummary,
  getDetailedStats,
  getDriverForApproval,
  getPendingWithdrawals,
  getUserTransactions,
  handleWithdrawal,
  updateDriverApproval,
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

//wallet routes

router.get("/transactions/:userId", verifyAdmin, getUserTransactions);
router.post("/wallet/:userId/adjust", verifyAdmin, adjustWalletBalance);
router.get("/wallets/summary", verifyAdmin, getAllWalletsSummary);

// Add new route for getting all users
router.get("/users", verifyAdmin, getAllUsers);

// Driver approval routes
router.get("/drivers/approval", verifyAdmin, getAllDriversForApproval);
router.get("/drivers/approval/:driverId", verifyAdmin, getDriverForApproval);
router.post("/drivers/approval/:driverId", verifyAdmin, updateDriverApproval);

export { router as adminRouter };
