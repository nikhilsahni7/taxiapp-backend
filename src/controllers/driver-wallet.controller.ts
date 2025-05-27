import { Response } from "express";
import { AuthenticatedRequest } from "../middlewares/auth.middleware"; // Assuming you have this for driver authentication
import {
  checkInsufficientBalance,
  updateInsufficientBalanceStatus,
} from "../services/driver-wallet.service";

/**
 * @route GET /api/driver/wallet/status
 * @desc Check if the authenticated driver has an insufficient balance.
 * @access Private (Driver only)
 */
export const getDriverWalletStatus = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  const driverId = req.user?.id; // Assuming driver ID is available on req.user after authentication

  if (!driverId) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Driver ID not found." });
  }

  try {
    // It's good practice to update the status before checking, to ensure it's current.
    await updateInsufficientBalanceStatus(driverId);
    const hasInsufficientBalance = await checkInsufficientBalance(driverId);

    if (hasInsufficientBalance) {
      return res.status(200).json({
        message:
          "Insufficient balance. Please pay outstanding dues to accept rides.",
        hasInsufficientBalance: true,
      });
    }

    return res.status(200).json({
      message: "Sufficient balance.",
      hasInsufficientBalance: false,
    });
  } catch (error: any) {
    console.error("Error checking driver wallet status:", error);
    return res
      .status(500)
      .json({ message: "Error checking wallet status.", error: error.message });
  }
};

/**
 * @route POST /api/driver/wallet/update-status
 * @desc Manually trigger an update of the driver's insufficient balance status.
 *       This could be useful after a payment or for periodic checks.
 * @access Private (Driver or Admin)
 */
export const triggerUpdateDriverWalletStatus = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  const driverId = req.user?.id; // Or get from req.params if an admin is updating for a specific driver

  if (!driverId) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Driver ID not found." });
  }

  try {
    await updateInsufficientBalanceStatus(driverId);
    const hasInsufficientBalance = await checkInsufficientBalance(driverId);

    return res.status(200).json({
      message: "Driver wallet status updated successfully.",
      hasInsufficientBalance,
    });
  } catch (error: any) {
    console.error("Error updating driver wallet status:", error);
    return res
      .status(500)
      .json({ message: "Error updating wallet status.", error: error.message });
  }
};
