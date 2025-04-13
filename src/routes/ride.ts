//ride.ts-> file

import type { RequestHandler } from "express";
import express from "express";
import {
  acceptRental,
  cancelRental,
  confirmCashPayment,
  createCarRental,
  getAvailableRentals,
  getRentalStatus,
  markDriverArrived,
  requestEndRental,
  startRide,
  verifyRazorpayPayment,
} from "../controllers/carRentalController";
import { getOutstationFareEstimate } from "../controllers/outstationController";
import {
  createRide,
  getChatMessages,
  getFareEstimation,
  getRide,
  getUserSelfieUrl,
  updateRideStatus,
} from "../controllers/rideController";
import { getAllUsersWithDetails } from "../controllers/userController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

router.post("/", verifyToken, createRide as RequestHandler);
router.get("/:id", verifyToken, getRide as RequestHandler);
router.put("/:id/status", verifyToken, updateRideStatus as RequestHandler);
router.post(
  "/fare-estimation",
  verifyToken,
  getFareEstimation as RequestHandler
);
router.post(
  "/outstation/fare-estimation",
  verifyToken,
  getOutstationFareEstimate as RequestHandler
);
router.get("/:id/chat", verifyToken, getChatMessages as RequestHandler);

// Car rental routes
router.post("/rental", verifyToken, createCarRental as RequestHandler);
router.get(
  "/rental/:id/status",
  verifyToken,
  getRentalStatus as RequestHandler
);
router.post(
  "/rental/:id/arrive",
  verifyToken,
  markDriverArrived as RequestHandler
);
router.post("/rental/:id/start", verifyToken, startRide as RequestHandler);
router.post("/rental/:id/cancel", verifyToken, cancelRental as RequestHandler);

router.get(
  "/rental/available",
  verifyToken,
  getAvailableRentals as RequestHandler
);
router.post(
  "/rental/:rentalId/accept",
  verifyToken,
  acceptRental as RequestHandler
);

//  rental final  payment flow routes
router.post(
  "/rental/:id/end-request",
  verifyToken,
  requestEndRental as RequestHandler
);

router.post(
  "/rental/:id/confirm-cash",
  verifyToken,
  confirmCashPayment as RequestHandler
);
router.post(
  "/rental/:id/verify-payment",
  verifyToken,
  verifyRazorpayPayment as RequestHandler
);

// Add new route for getting selfie URLs
router.get(
  "/user/:userId/selfie",
  verifyToken,
  getUserSelfieUrl as RequestHandler
);
router.get("/all/users", verifyToken, getAllUsersWithDetails as RequestHandler);

export { router as rideRouter };
