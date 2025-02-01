//ride.ts-> file

import express from "express";
import {
  createRide,
  getRide,
  updateRideStatus,
  getFareEstimation,
  getChatMessages,
} from "../controllers/rideController";
import { verifyToken } from "../middlewares/auth";
import { getOutstationFareEstimate } from "../controllers/outstationController";
import {
  createCarRental,
  getRentalStatus,
  markDriverArrived,
  startRide,
  cancelRental,
  endRide,
  getAvailableRentals,
  acceptRental,
  requestEndRental,
  initiateRentalPayment,
  confirmCashPayment,
  verifyRazorpayPayment,
} from "../controllers/carRentalController";

const router = express.Router();

router.post("/", verifyToken, createRide);
router.get("/:id", verifyToken, getRide);
router.put("/:id/status", verifyToken, updateRideStatus);
router.post("/fare-estimation", verifyToken, getFareEstimation);
router.post(
  "/outstation/fare-estimation",
  verifyToken,
  getOutstationFareEstimate
);
router.get("/:id/chat", verifyToken, getChatMessages);

// Car rental routes
router.post("/rental", verifyToken, createCarRental);
router.get("/rental/:id/status", verifyToken, getRentalStatus);
router.post("/rental/:id/arrive", verifyToken, markDriverArrived);
router.post("/rental/:id/start", verifyToken, startRide);
router.post("/rental/:id/cancel", verifyToken, cancelRental);
router.post("/rental/:id/end", verifyToken, endRide);
router.get("/rental/available", verifyToken, getAvailableRentals);
router.post("/rental/:rentalId/accept", verifyToken, acceptRental);

// New rental payment flow routes
router.post("/rental/:id/end-request", verifyToken, requestEndRental);
router.post("/rental/:id/payment", verifyToken, initiateRentalPayment);
router.post("/rental/:id/confirm-cash", verifyToken, confirmCashPayment);
router.post("/rental/:id/verify-payment", verifyToken, verifyRazorpayPayment);

export { router as rideRouter };
