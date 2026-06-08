import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { Order } from '../types';
import logger from '../utils/logger';

const ORDERS_FILE = path.join('data', 'orders.xlsx');
const FINANCE_FILE = path.join('data', 'finance.xlsx');

const HEADERS = [
  'التاريخ والوقت',
  'رقم الطلب',
  'اسم العميل',
  'رقم الجوال',
  'اسم المستلم',
  'المنتج',
  'السعر (ريال)',
  'حالة الدفع',
  'رابط الموقع',
  'رقم البطاقة',
  'صورة المنتج',
  'ملاحظات',
];

async function getWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  if (fs.existsSync(filePath)) {
    await workbook.xlsx.readFile(filePath);
  } else {
    const sheet = workbook.addWorksheet('الطلبات');
    const headerRow = sheet.addRow(HEADERS);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };
    HEADERS.forEach((_, i) => {
      sheet.getColumn(i + 1).width = 20;
    });
  }

  return workbook;
}

export async function addOrder(order: Order): Promise<void> {
  try {
    const workbook = await getWorkbook(ORDERS_FILE);
    const sheet = workbook.getWorksheet('الطلبات') || workbook.worksheets[0];

    sheet.addRow([
      order.timestamp,
      order.id,
      order.customerName,
      order.customerPhone,
      order.recipientName,
      order.product,
      order.price,
      order.paymentStatus,
      order.locationUrl,
      order.cardLast4,
      order.productImageUrl,
      order.notes,
    ]);

    await workbook.xlsx.writeFile(ORDERS_FILE);
    logger.info(`[Agent3] Order ${order.id} added to Excel`);
  } catch (err: any) {
    logger.error(`[Agent3] Failed to add order: ${err.message}`);
    throw err;
  }
}

export async function updateOrderStatus(
  orderId: string,
  status: 'PENDING' | 'CONFIRMED' | 'FAILED',
  cardLast4?: string
): Promise<void> {
  try {
    const workbook = await getWorkbook(ORDERS_FILE);
    const sheet = workbook.getWorksheet('الطلبات') || workbook.worksheets[0];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(2).value === orderId) {
        row.getCell(8).value = status;
        if (cardLast4) row.getCell(10).value = `****${cardLast4}`;
      }
    });

    await workbook.xlsx.writeFile(ORDERS_FILE);
    logger.info(`[Agent3] Order ${orderId} status updated to ${status}`);
  } catch (err: any) {
    logger.error(`[Agent3] Failed to update order status: ${err.message}`);
  }
}

export async function updateOrderPaymentSession(
  orderId: string,
  sessionId: string
): Promise<void> {
  try {
    const workbook = await getWorkbook(ORDERS_FILE);
    const sheet = workbook.getWorksheet('الطلبات') || workbook.worksheets[0];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(2).value === orderId) {
        row.getCell(12).value = `stripe:${sessionId}`;
      }
    });

    await workbook.xlsx.writeFile(ORDERS_FILE);
    logger.info(`[Agent3] Payment session linked to order ${orderId}`);
  } catch (err: any) {
    logger.error(`[Agent3] Failed to update payment session: ${err.message}`);
  }
}

export async function addFinanceRecord(
  orderId: string,
  amount: number,
  customerName: string
): Promise<void> {
  try {
    const workbook = new ExcelJS.Workbook();
    const financeHeaders = ['التاريخ', 'رقم الطلب', 'العميل', 'المبلغ (ريال)', 'الحالة'];

    if (fs.existsSync(FINANCE_FILE)) {
      await workbook.xlsx.readFile(FINANCE_FILE);
    } else {
      const sheet = workbook.addWorksheet('المالية');
      const headerRow = sheet.addRow(financeHeaders);
      headerRow.font = { bold: true };
      financeHeaders.forEach((_, i) => {
        sheet.getColumn(i + 1).width = 20;
      });
    }

    const sheet = workbook.getWorksheet('المالية') || workbook.worksheets[0];
    sheet.addRow([
      new Date().toISOString(),
      orderId,
      customerName,
      amount,
      'CONFIRMED',
    ]);

    await workbook.xlsx.writeFile(FINANCE_FILE);
    logger.info(`[Agent3] Finance record added for order ${orderId}`);
  } catch (err: any) {
    logger.error(`[Agent3] Failed to add finance record: ${err.message}`);
  }
}

export async function getOrderByStripeSession(
  sessionId: string
): Promise<{ orderId: string; phone: string; name: string } | null> {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return null;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(ORDERS_FILE);
    const sheet = workbook.getWorksheet('الطلبات') || workbook.worksheets[0];

    let found: { orderId: string; phone: string; name: string } | null = null;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const notes = String(row.getCell(12).value || '');
      if (notes === `stripe:${sessionId}`) {
        found = {
          orderId: String(row.getCell(2).value),
          phone: String(row.getCell(4).value),
          name: String(row.getCell(3).value),
        };
      }
    });

    return found;
  } catch {
    return null;
  }
}
