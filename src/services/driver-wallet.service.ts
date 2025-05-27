import { prisma } from "../lib/prisma";

interface WalletBalanceStatus {
  hasInsufficientBalance: boolean;
  currentBalance: number;
  balanceThresholds: {
    isNegative: boolean; // balance < 0
    isAtWarningLevel: boolean; // balance <= -25
    isAtCriticalLevel: boolean; // balance <= -75
    isBlocked: boolean; // balance <= -100
  };
  message: string;
}

/**
 * Updates the `hasInsufficientBalance` flag for a driver based on their wallet balance.
 * If the driver's wallet balance is less than or equal to -100, the flag is set to true.
 * Otherwise, it's set to false.
 *
 * @param driverId The ID of the driver.
 * @returns A Promise that resolves when the update is complete.
 * @throws Error if the driver or their wallet is not found.
 */
export const updateInsufficientBalanceStatus = async (
  driverId: string
): Promise<void> => {
  const driver = await prisma.user.findUnique({
    where: { id: driverId, userType: "DRIVER" },
    include: { wallet: true, driverDetails: true },
  });

  if (!driver) {
    throw new Error("Driver not found.");
  }

  if (!driver.wallet) {
    await prisma.wallet.create({
      data: {
        userId: driverId,
        balance: 0,
      },
    });
    // Re-fetch driver with wallet
    const updatedDriver = await prisma.user.findUnique({
      where: { id: driverId },
      include: { wallet: true, driverDetails: true },
    });
    if (!updatedDriver?.wallet) {
      throw new Error("Failed to create or find wallet for driver.");
    }
    driver.wallet = updatedDriver.wallet;
  }

  const hasInsufficientBalance = driver.wallet.balance <= -100;

  if (driver.driverDetails) {
    await prisma.driverDetails.update({
      where: { userId: driverId },
      data: { hasInsufficientBalance },
    });
  } else {
    throw new Error("Driver details not found for the specified driver.");
  }
};

/**
 * Checks the driver's wallet balance status and returns detailed information
 * about different balance thresholds.
 *
 * @param driverId The ID of the driver.
 * @returns A Promise that resolves to a WalletBalanceStatus object containing detailed balance information.
 * @throws Error if the driver or their wallet is not found.
 */
export const checkWalletBalanceStatus = async (
  driverId: string
): Promise<WalletBalanceStatus> => {
  const driver = await prisma.user.findUnique({
    where: { id: driverId, userType: "DRIVER" },
    include: { wallet: true },
  });

  if (!driver) {
    throw new Error("Driver not found.");
  }

  if (!driver.wallet) {
    throw new Error("Driver wallet not found.");
  }

  const balance = driver.wallet.balance;
  const isNegative = balance < 0;
  const isAtWarningLevel = balance <= -25;
  const isAtCriticalLevel = balance <= -75;
  const isBlocked = balance <= -100;

  let message = "Your wallet balance is healthy.";
  if (isBlocked) {
    message =
      "Your account has been blocked. Please clear your dues to continue accepting rides.";
  } else if (isAtCriticalLevel) {
    message =
      "Critical: Your account will be blocked at -100. Please add funds immediately.";
  } else if (isAtWarningLevel) {
    message = "Warning: Your balance is getting low. Please add funds soon.";
  } else if (isNegative) {
    message = "Your balance is negative. Consider adding funds.";
  }

  return {
    hasInsufficientBalance: isBlocked,
    currentBalance: balance,
    balanceThresholds: {
      isNegative,
      isAtWarningLevel,
      isAtCriticalLevel,
      isBlocked,
    },
    message,
  };
};


/**
 * Checks if a driver has an insufficient balance.
 *
 * @param driverId The ID of the driver.
 * @returns A Promise that resolves to true if the driver has an insufficient balance, false otherwise.
 * @throws Error if the driver or their driver details are not found.
 */
export const checkInsufficientBalance = async (
  driverId: string
): Promise<boolean> => {
  const driverDetails = await prisma.driverDetails.findUnique({
    where: { userId: driverId },
  });

  if (!driverDetails) {
    // It's important to update the status first in case it's stale
    await updateInsufficientBalanceStatus(driverId);
    const updatedDriverDetails = await prisma.driverDetails.findUnique({
      where: { userId: driverId },
    });
    if (!updatedDriverDetails) {
      throw new Error(
        "Driver details not found even after attempting to update status."
      );
    }
    return updatedDriverDetails.hasInsufficientBalance;
  }

  return driverDetails.hasInsufficientBalance;
};
