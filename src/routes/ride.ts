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
  getUnreadMessageCount,
  getUserSelfieUrl,
  getWaitingTimeDetails,
  updateRideStatus,
} from "../controllers/rideController";
import { getAllUsersWithDetails } from "../controllers/userController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

router.post("/", verifyToken, createRide as unknown as RequestHandler);
router.get("/:id", verifyToken, getRide as unknown as RequestHandler);
router.put(
  "/:id/status",
  verifyToken,
  updateRideStatus as unknown as RequestHandler
);
router.post(
  "/fare-estimation",
  verifyToken,
  getFareEstimation as unknown as RequestHandler
);
router.post(
  "/outstation/fare-estimation",
  verifyToken,
  getOutstationFareEstimate as unknown as RequestHandler
);
router.get(
  "/:id/chat",
  verifyToken,
  getChatMessages as unknown as RequestHandler
);

// Add new route for getting unread message count
router.get(
  "/:rideId/chat/unread/:userId",
  verifyToken,
  getUnreadMessageCount as unknown as RequestHandler
);

// New route to get waiting time details
router.get(
  "/:id/waiting-time",
  verifyToken,
  getWaitingTimeDetails as unknown as RequestHandler
);

// Car rental routes
router.post(
  "/rental",
  verifyToken,
  createCarRental as unknown as RequestHandler
);
router.get(
  "/rental/:id/status",
  verifyToken,
  getRentalStatus as unknown as RequestHandler
);
router.post(
  "/rental/:id/arrive",
  verifyToken,
  markDriverArrived as unknown as RequestHandler
);
router.post(
  "/rental/:id/start",
  verifyToken,
  startRide as unknown as RequestHandler
);
router.post(
  "/rental/:id/cancel",
  verifyToken,
  cancelRental as unknown as RequestHandler
);

router.get(
  "/rental/available",
  verifyToken,
  getAvailableRentals as unknown as RequestHandler
);
router.post(
  "/rental/:rentalId/accept",
  verifyToken,
  acceptRental as unknown as RequestHandler
);

//  rental final  payment flow routes
router.post(
  "/rental/:id/end-request",
  verifyToken,
  requestEndRental as unknown as RequestHandler
);

router.post(
  "/rental/:id/confirm-cash",
  verifyToken,
  confirmCashPayment as unknown as RequestHandler
);
router.post(
  "/rental/:id/verify-payment",
  verifyToken,
  verifyRazorpayPayment as unknown as RequestHandler
);

// Add new route for getting selfie URLs
router.get(
  "/user/:userId/selfie",
  verifyToken,
  getUserSelfieUrl as unknown as RequestHandler
);
router.get(
  "/all/users",
  verifyToken,
  getAllUsersWithDetails as unknown as RequestHandler
);

export { router as rideRouter };
