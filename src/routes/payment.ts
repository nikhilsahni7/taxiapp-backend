import { handleRideEnd } from "./../controllers/paymentController";
import express from "express";
import {
  initiateRazorpayPayment,
  verifyPayment,
} from "../controllers/paymentController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

// Payment Routes
router.post("/initiate/:rideId", verifyToken, initiateRazorpayPayment);
router.post("/verify", verifyToken, verifyPayment);
router.put("/complete/:rideId", verifyToken, handleRideEnd);

export { router as paymentRouter };
