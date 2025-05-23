import express from "express";

import {
  acceptOutstationBooking,
  cancelBooking,
  confirmRideCompletion,
  createFinalPaymentOrder,
  driverArrived,
  getAcceptedBookings,
  getAvailableBookings,
  getBookingStatus,
  getOutstationFareEstimate,
  initiateRideCompletion,
  searchOutstationDrivers,
  startDriverPickup,
  startRide,
  verifyAdvancePayment,
} from "../controllers/outstationController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

// All routes are protected with auth middleware
router.use(verifyToken);

// User routes
router.post("/fare-estimate", getOutstationFareEstimate);
router.post("/search-drivers", searchOutstationDrivers);

router.post(
  "/bookings/:bookingId/verify-advance-payment",
  verifyAdvancePayment
);

// Driver routes
router.post("/bookings/:bookingId/accept", acceptOutstationBooking);
router.post("/bookings/:bookingId/start-pickup", startDriverPickup);
router.post("/bookings/:bookingId/arrived", driverArrived);
router.post("/bookings/:bookingId/start", startRide);
router.get("/bookings/accepted", verifyToken, getAcceptedBookings);

// Common routes
router.post("/bookings/:bookingId/cancel", cancelBooking);
router.get("/available-bookings", getAvailableBookings);
router.get("/bookings/:bookingId", getBookingStatus);

// payment routes -final payment
router.post("/bookings/:bookingId/initiate-completion", initiateRideCompletion);
router.post("/bookings/:bookingId/confirm-completion", confirmRideCompletion);
router.post(
  "/bookings/:bookingId/create-final-payment-order",
  createFinalPaymentOrder
);

export { router as outstationRouter };
