import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";

// 1. Initialize the "Admin" connection to Firestore
initializeApp();
const db = getFirestore();

// 2. The Trigger: Runs AUTOMATICALLY when a doc is created in 'orders'
export const onOrderCreated = onDocumentCreated("orders/{orderId}", async (event) => {
  // Safety Check: Ensure data exists
  const snapshot = event.data;
  if (!snapshot) {
    return;
  }

  const orderData = snapshot.data();
  const orderId = event.params.orderId;
  
  // 3. Extract Vendor ID and Quantity
  const vendorId = orderData.vendor.uid;
  const items = orderData.items || [];

  // Calculate total cans ordered
  let totalQuantity = 0;
  items.forEach((item: any) => {
    totalQuantity += (item.quantity || 0);
  });

  logger.info(`Order ${orderId}: Decrementing ${totalQuantity} cans from Vendor ${vendorId}`);

  // 4. The Transaction (Safe Update)
  try {
    await db.runTransaction(async (transaction) => {
      const vendorRef = db.collection("users").doc(vendorId);
      const vendorDoc = await transaction.get(vendorRef);

      if (!vendorDoc.exists) {
        logger.error(`Vendor ${vendorId} not found!`);
        return;
      }

      const currentStock = vendorDoc.data()?.inventoryCount || 0;
      const newStock = currentStock - totalQuantity;

      // Update the DB
      transaction.update(vendorRef, { inventoryCount: newStock });
      
      logger.info(`Vendor ${vendorId} stock updated: ${currentStock} -> ${newStock}`);
    });
  } catch (error) {
    logger.error("Transaction failed", error);
  }
});

export const onOrderStatusChange = onDocumentUpdated("orders/{orderId}", async (event) => {
  const oldData = event.data?.before.data();
  const newData = event.data?.after.data();

  if (!oldData || !newData) return;

  const oldStatus = oldData.status;
  const newStatus = newData.status;
  const vendorId = newData.vendor.uid;

  // LOGIC: Only run if status CHANGED to 'CANCELLED'
  if (oldStatus !== 'CANCELLED' && newStatus === 'CANCELLED') {
    
    const items = newData.items || [];
    let quantityToRestore = 0;
    items.forEach((item: any) => {
      quantityToRestore += (item.quantity || 0);
    });

    logger.info(`Order ${event.params.orderId} cancelled. Restoring ${quantityToRestore} cans to Vendor ${vendorId}`);

    try {
      await db.runTransaction(async (t) => {
        const vendorRef = db.collection("users").doc(vendorId);
        const vendorDoc = await t.get(vendorRef);
        
        if (!vendorDoc.exists) return;

        const currentStock = vendorDoc.data()?.inventoryCount || 0;
        const newStock = currentStock + quantityToRestore;

        t.update(vendorRef, { inventoryCount: newStock });
      });
      logger.info("Stock restored.");
    } catch (error) {
      logger.error("Restoration failed", error);
    }
  }
});