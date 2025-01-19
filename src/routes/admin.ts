import express from "express";
import {
  getTotalRides,
  getActiveRides,
  getLongDistanceRides,
  getTotalDrivers,
  getTotalUsers,
  getTotalVendors,
  getTotalWalletBalances,
  getPendingWithdrawals,
  handleWithdrawal,
} from "../controllers/adminController";
import { verifyAdmin } from "../middlewares/auth";

const router = express.Router();

// Ride-related routes
router.get("/rides/total", verifyAdmin, getTotalRides);
router.get("/rides/active", verifyAdmin, getActiveRides);
router.get("/rides/long-distance", verifyAdmin, getLongDistanceRides);

// User-related routes
router.get("/users/total", verifyAdmin, getTotalUsers);
router.get("/drivers/total", verifyAdmin, getTotalDrivers);
router.get("/vendors/total", verifyAdmin, getTotalVendors);

// Wallet-related routes
router.get("/wallets/total", verifyAdmin, getTotalWalletBalances);

// Withdrawal-related routes
router.get("/withdrawals", verifyAdmin, getPendingWithdrawals);
router.post("/withdrawals/:transactionId", verifyAdmin, handleWithdrawal);

export { router as adminRouter };
