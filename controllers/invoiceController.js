/**
 * Invoice Controller for MCP Server
 * Handles invoice lookup with parallel domain/email validation and phone validation
 */

const { getInvoice, getInvoices, getClientsDetails, callApi } = require('../services/whmcsService');
const { findRelatedUnpaidInvoice, amountFromInvoice, toMessageStatus } = require('../utils/helpers');
const { normalizePhone, phonesMatch } = require('../utils/phoneNormalizer');

/**
 * Simple email validation helper
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Helper function to mask phone number
 */
function maskPhoneNumber(phone) {
  if (!phone || phone.length < 4) return phone;
  
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  const visibleStart = Math.min(3, Math.floor(cleaned.length / 3));
  const visibleEnd = Math.min(3, Math.floor(cleaned.length / 4));
  
  if (cleaned.length <= visibleStart + visibleEnd) {
    return phone; // Too short to mask meaningfully
  }
  
  const start = cleaned.substring(0, visibleStart);
  const end = cleaned.substring(cleaned.length - visibleEnd);
  const middle = '*'.repeat(Math.min(3, cleaned.length - visibleStart - visibleEnd));
  
  return start + middle + end;
}

/**
 * Helper function to resolve domain to client
 */
async function resolveDomainToClient(domain) {
  const startTime = Date.now();
  try {
    console.log(`→ [Domain Resolution] Trying GetClientsDomains for: ${domain}`);
    // Try GetClientsDomains first (more specific for domains)
    const domainsData = await callApi('GetClientsDomains', { domain });
    console.log(`→ [Domain Resolution] GetClientsDomains completed in ${Date.now() - startTime}ms`);
    
    if (domainsData && domainsData.domains) {
      const domainsRaw = domainsData.domains;
      const domains = domainsRaw.domain || domainsRaw;
      const domainArray = Array.isArray(domains) ? domains : (domains ? [domains] : []);
      
      if (domainArray.length > 0) {
        const uniqueUserIds = [...new Set(domainArray.map(d => String(d.userid)))];
        
        if (uniqueUserIds.length > 1) {
          throw new Error('Multiple clients found for this domain');
        }
        
        return { clientId: uniqueUserIds[0], source: 'domains' };
      }
    }
  } catch (error) {
    console.log(`→ [Domain Resolution] GetClientsDomains error after ${Date.now() - startTime}ms:`, error.message);
  }
  
  const fallbackStartTime = Date.now();
  try {
    console.log(`→ [Domain Resolution] Trying GetClientsProducts for: ${domain}`);
    // Fallback: Try GetClientsProducts with domain parameter
    const productsData = await callApi('GetClientsProducts', { domain });
    console.log(`→ [Domain Resolution] GetClientsProducts completed in ${Date.now() - fallbackStartTime}ms`);
    
    if (productsData && productsData.products) {
      const productsRaw = productsData.products;
      const products = productsRaw.product || productsRaw;
      const productArray = Array.isArray(products) ? products : (products ? [products] : []);
      
      if (productArray.length > 0) {
        const uniqueUserIds = [...new Set(productArray.map(p => String(p.userid || p.clientid)))];
        
        if (uniqueUserIds.length > 1) {
          throw new Error('Multiple clients found for this domain');
        }
        
        return { clientId: uniqueUserIds[0], source: 'products' };
      }
    }
  } catch (error) {
    console.log(`→ [Domain Resolution] GetClientsProducts error after ${Date.now() - fallbackStartTime}ms:`, error.message);
  }
  
  throw new Error('No client found with that domain');
}

/**
 * Helper function to resolve email to client
 */
async function resolveEmailToClient(email) {
  try {
    const clientData = await getClientsDetails({ email });
    
    if (clientData && clientData.userid) {
      return { clientId: String(clientData.userid), source: 'email' };
    }
    
    throw new Error('No client found with that email address');
  } catch (error) {
    console.log('→ Email resolution error:', error.message);
    throw new Error('No client found with that email address');
  }
}

/**
 * Helper function to validate client phone number
 */
async function validateClientPhone(clientId, providedPhone) {
  try {
    const clientData = await getClientsDetails({ clientid: clientId });
    
    if (!clientData) {
      throw new Error('Client not found');
    }
    
    const registeredPhone = clientData.phonenumber || clientData.phone;
    
    if (!registeredPhone) {
      // No phone number on file - allow access
      return { valid: true, reason: 'no_phone_on_file' };
    }
    
    // Use the phone normalizer utility for consistent validation
    const isMatch = phonesMatch(registeredPhone, providedPhone);
    
    console.log(`→ Phone validation: Registered=${normalizePhone(registeredPhone).substring(0, 3)}***, Provided=${normalizePhone(providedPhone).substring(0, 3)}***, Match=${isMatch}`);
    
    return {
      valid: isMatch,
      registeredPhone: registeredPhone,
      reason: isMatch ? 'phone_match' : 'phone_mismatch'
    };
    
  } catch (error) {
    throw new Error(`Phone validation failed: ${error.message}`);
  }
}

/**
 * Invoice lookup with parallel domain/email validation and phone as second-level validation
 * Also supports invoice-only lookup when domain and email are empty
 * 
 * This is the core function used by the MCP tool
 */
async function invoiceLookup(params) {
  const startTime = Date.now();
  const { clientId, invoiceId, domain, email, phone } = params || {};
  
  // Single entry log with key identifiers
  console.log(`[invoiceLookup] clientId=${clientId || 'auto'}, invoiceId=${invoiceId || 'auto'}, domain=${domain || 'N/A'}, email=${email ? 'provided' : 'N/A'}`);
  
  try {
    
    // Validate email if provided (even if empty string)
    if (email !== undefined && email !== null && email !== '') {
      if (!isValidEmail(email)) {
        return { 
          success: false, 
          error: 'Invalid email format provided' 
        };
      }
    }
    
    // Validate invoiceId format if provided
    let targetInvoiceId = invoiceId;
    if (targetInvoiceId !== undefined && targetInvoiceId !== null && targetInvoiceId !== '' && targetInvoiceId !== 0 && targetInvoiceId !== '0') {
      const numericId = String(targetInvoiceId);
      if (!numericId.match(/^\d+$/) || parseInt(numericId) <= 0) {
        return { success: false, error: 'Invalid invoiceId format. Invoice ID must be a positive number.' };
      }
    } else {
      // Empty, null, undefined, 0, or '0' invoice ID - treat as no invoice provided
      if (targetInvoiceId === 0 || targetInvoiceId === '0') {
        console.log('→ Invoice ID 0 provided - treating as null (no specific invoice requested)');
      }
      targetInvoiceId = null;
    }
    
    let resolvedClientId = clientId;
    let resolvedFrom = params._resolvedFrom;
    
    // Check if invoice ID is 5 digits (paid invoice number format in WHMCS)
    const isFiveDigitInvoice = targetInvoiceId && String(targetInvoiceId).length === 5;
    
    // PRIORITY: When domain/email is provided with a 5-digit invoice, prioritize domain/email resolution
    // This is because 5-digit invoice numbers can exist for multiple clients in WHMCS
    const shouldPrioritizeDomainEmail = isFiveDigitInvoice && (domain || email);
    
    if (shouldPrioritizeDomainEmail) {
      console.log('→ 5-digit invoice with domain/email - will resolve client from domain/email first, then validate invoice');
    } else if (targetInvoiceId && !domain && !email) {
      // Only invoice provided (no domain/email) - resolve from invoice
      console.log('→ Invoice provided without domain/email - attempting to resolve client from invoice:', targetInvoiceId);
      
      try {
        const invoice = await getInvoice(targetInvoiceId);
        
        if (invoice && invoice.invoiceid) {
          resolvedClientId = String(invoice.userid || invoice.user_id || invoice.clientid);
          resolvedFrom = 'invoice';
          console.log('→ Client resolved from invoice:', resolvedClientId);
        }
      } catch (err) {
        console.log('→ Invoice lookup failed:', err.message);
        return {
          success: false,
          error: 'Invoice not found. Please verify the invoice number.'
        };
      }
    }
    
    // Resolve client from domain OR email (try sequentially with individual timeouts)
    if (!resolvedClientId && (domain || email)) {
      console.log('→ Starting client resolution...');
      
      // Try domain first if provided
      if (domain) {
        console.log('→ Attempting domain resolution for:', domain);
        try {
          const domainPromise = resolveDomainToClient(domain);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Domain resolution timeout')), 30000) // Increased to 30s
          );
          
          const domainResult = await Promise.race([domainPromise, timeoutPromise]);
          resolvedClientId = domainResult.clientId;
          resolvedFrom = 'domain';
          console.log('→ Client resolved from domain:', resolvedClientId);
        } catch (error) {
          console.log('→ Domain resolution failed:', error.message);
          
          // If domain fails and email is provided, try email
          if (email) {
            console.log('→ Attempting email resolution for:', email);
            try {
              const emailPromise = resolveEmailToClient(email);
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Email resolution timeout')), 30000) // Increased to 30s
              );
              
              const emailResult = await Promise.race([emailPromise, timeoutPromise]);
              resolvedClientId = emailResult.clientId;
              resolvedFrom = 'email';
              console.log('→ Client resolved from email:', resolvedClientId);
            } catch (emailError) {
              console.log('→ Email resolution failed:', emailError.message);
            }
          }
        }
      } else if (email) {
        // Only email provided
        console.log('→ Attempting email resolution for:', email);
        try {
          const emailPromise = resolveEmailToClient(email);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Email resolution timeout')), 30000) // Increased to 30s
          );
          
          const emailResult = await Promise.race([emailPromise, timeoutPromise]);
          resolvedClientId = emailResult.clientId;
          resolvedFrom = 'email';
          console.log('→ Client resolved from email:', resolvedClientId);
        } catch (error) {
          console.log('→ Email resolution failed:', error.message);
        }
      }
      
      // If still not resolved, return error
      if (!resolvedClientId) {
        const errorMessages = [];
        if (domain) errorMessages.push('No client found for the provided domain');
        if (email) errorMessages.push('No client found for the provided email');
        
        return {
          success: false,
          error: errorMessages.join(' and ') + '. Please verify your information or try again later.'
        };
      }
    }
    
    // SECOND-LEVEL VALIDATION: Phone validation if provided
    if (phone && resolvedClientId) {
      console.log('→ Performing second-level phone validation...');
      
      try {
        const phoneValidationResult = await validateClientPhone(resolvedClientId, phone);
        
        if (!phoneValidationResult.valid) {
          // Phone validation failed - return masked phone error with update instructions
          const maskedPhone = phoneValidationResult.registeredPhone 
            ? maskPhoneNumber(phoneValidationResult.registeredPhone)
            : 'your registered number';
            
          return {
            success: false,
            error: `Please contact from ${maskedPhone} or change the phone number from your client area to ${phone}`,
            phoneValidationFailed: true,
            resolvedFrom: resolvedFrom
          };
        }
        
        console.log('✓ Phone validation passed');
      } catch (error) {
        console.log('✗ Phone validation error:', error.message);
        return {
          success: false,
          error: 'Phone validation failed. Please try again or contact support.'
        };
      }
    } else if (phone && !resolvedClientId) {
      return {
        success: false,
        error: 'Unable to identify client for phone validation. Please verify your domain or email.'
      };
    }
    
    // Validate that we have a resolved client
    if (!resolvedClientId) {
      if (targetInvoiceId) {
        return { 
          success: false, 
          error: 'Unable to identify client from invoice. Please provide domain or email address.' 
        };
      } else if (phone) {
        return { 
          success: false, 
          error: 'Please provide either a domain name, email address, or invoice number along with phone number for validation.' 
        };
      } else {
        return { 
          success: false, 
          error: 'Please provide either a domain name, email address, or invoice number to identify your account.' 
        };
      }
    }
    
    let invoice;
    if (targetInvoiceId) {
      // When domain/email is provided with invoice ID, search through client's invoices
      // This is especially important for 5-digit invoice numbers which can exist for multiple clients
      if (resolvedClientId && (domain || email)) {
        console.log('→ Searching through client invoices for invoice ID/NUM:', targetInvoiceId);
        
        try {
          // Get all invoices for this client
          const allInvoices = await getInvoices({ 
            userid: resolvedClientId, 
            limitnum: 999
          });
          
          const invoiceArray = allInvoices.invoices?.invoice || allInvoices.invoices?.invoices || [];
          const invoices = Array.isArray(invoiceArray) ? invoiceArray : (invoiceArray ? [invoiceArray] : []);
          
          console.log(`→ Searching through ${invoices.length} invoices for client ${resolvedClientId}`);
          
          // Search for invoice by BOTH invoiceid AND invoicenum fields
          // This handles WHMCS's behavior where paid invoices get 5-digit numbers
          const matchingInvoice = invoices.find(inv => {
            const invId = String(inv.id || inv.invoiceid || '');
            const invNum = String(inv.invoicenum || inv.invoice_num || '');
            const targetId = String(targetInvoiceId);
            
            const idMatch = invId === targetId;
            const numMatch = invNum === targetId;
            
            if (idMatch || numMatch) {
              console.log(`→ Found matching invoice: ID=${invId}, NUM=${invNum}, Target=${targetId}, IDMatch=${idMatch}, NUMMatch=${numMatch}`);
              return true;
            }
            return false;
          });
          
          if (matchingInvoice) {
            const invoiceId = matchingInvoice.id || matchingInvoice.invoiceid;
            invoice = await getInvoice(invoiceId);
            console.log('✓ Invoice found and validated:', invoice.invoiceid || invoice.id, 'Status:', invoice.status);
          } else {
            console.log('→ No matching invoice found for this client');
          }
        } catch (err) {
          console.log('✗ Error searching client invoices:', err.message);
        }
      } else {
        // No domain/email provided - try direct invoice lookup
        try {
          invoice = await getInvoice(targetInvoiceId);
          console.log('→ Invoice fetched:', invoice.invoiceid || invoice.id, 'Owner:', invoice.userid || invoice.clientid);
          
          // Validate ownership if we have a resolved client
          if (resolvedClientId) {
            const ownerId = String(invoice.userid || invoice.user_id || invoice.clientid);
            if (String(ownerId) !== String(resolvedClientId)) {
              console.log('✗ Invoice ownership mismatch - invoice belongs to different client');
              return {
                success: false,
                error: 'The provided invoice does not belong to the identified account. Please verify your information.'
              };
            }
          }
        } catch (err) {
          console.log('✗ Invoice fetch failed:', err.message);
        }
      }
    }
    
    // If still no invoice found and no specific ID was provided, search for unpaid invoices as fallback
    if (!invoice && !targetInvoiceId) {
      console.log('→ No specific invoice ID provided, searching for unpaid invoices for client:', resolvedClientId);
      
      try {
        const unpaidInvoices = await getInvoices({ 
          userid: resolvedClientId, 
          status: 'Unpaid', 
          limitnum: 100  // Get up to 100 unpaid invoices
        });
        
        const invoiceArray = unpaidInvoices.invoices?.invoice || unpaidInvoices.invoices?.invoices || [];
        const invoices = Array.isArray(invoiceArray) ? invoiceArray : (invoiceArray ? [invoiceArray] : []);
        
        if (invoices.length > 0) {
          console.log(`→ Found ${invoices.length} unpaid invoice(s) for client`);
          
          // If multiple unpaid invoices, return all of them
          if (invoices.length > 1) {
            // Get full details for all unpaid invoices
            const invoiceDetails = await Promise.all(
              invoices.map(async (inv) => {
                const invoiceId = inv.id || inv.invoiceid;
                try {
                  const fullInvoice = await getInvoice(invoiceId);
                  
                  const status = toMessageStatus(fullInvoice.status);
                  const amount = amountFromInvoice(fullInvoice);
                  const dueDate = fullInvoice.duedate || null;
                  const invoiceIdOut = fullInvoice.invoiceid || fullInvoice.id;
                  const currency = fullInvoice.currencycode; // WHMCS field: currencycode (e.g., "USD", "PKR")
                  
                  // Check if overdue
                  let isOverdue = false;
                  if (dueDate && status !== 'Paid' && status !== 'Cancelled' && status !== 'Refunded') {
                    const dueDateObj = new Date(dueDate);
                    const now = new Date();
                    dueDateObj.setHours(0, 0, 0, 0);
                    now.setHours(0, 0, 0, 0);
                    isOverdue = dueDateObj < now;
                  }
                  
                  return {
                    invoiceId: invoiceIdOut,
                    status,
                    amount,
                    currency,
                    dueDate,
                    isOverdue
                  };
                } catch (err) {
                  console.log(`✗ Error fetching invoice ${invoiceId}:`, err.message);
                  return null;
                }
              })
            );
            
            // Filter out any failed fetches
            const validInvoices = invoiceDetails.filter(inv => inv !== null);
            
            if (validInvoices.length > 0) {
              // Get currency from first invoice (all should be same currency for a client)
              const currency = validInvoices[0]?.currency || 'PKR';
              
              // Calculate totals
              const totalAmount = validInvoices.reduce((sum, inv) => {
                const numAmount = parseFloat(String(inv.amount).replace(/[^0-9.-]/g, '')) || 0;
                return sum + numAmount;
              }, 0);
              
              const overdueCount = validInvoices.filter(inv => inv.isOverdue).length;
              
              // Build message
              let message = `You have ${validInvoices.length} unpaid invoice(s)`;
              if (overdueCount > 0) {
                message += `, ${overdueCount} of which ${overdueCount === 1 ? 'is' : 'are'} overdue`;
              }
              message += `. Total amount due: ${totalAmount.toFixed(2)} ${currency}.`;
              
              console.log('→ FINAL RESPONSE (Multiple invoices):', JSON.stringify({
                success: true,
                multipleInvoices: true,
                count: validInvoices.length,
                totalAmount: totalAmount.toFixed(2),
                currency,
                overdueCount
              }, null, 2));
              
              return {
                success: true,
                multipleInvoices: true,
                count: validInvoices.length,
                invoices: validInvoices,
                totalAmount: totalAmount.toFixed(2),
                currency,
                overdueCount,
                message
              };
            }
          } else {
            // Single unpaid invoice - use existing logic
            const firstInvoice = invoices[0];
            const invoiceId = firstInvoice.id || firstInvoice.invoiceid;
            
            if (invoiceId) {
              invoice = await getInvoice(invoiceId);
              console.log('→ Found unpaid invoice for client:', invoice.invoiceid || invoice.id);
            }
          }
        } else if (domain && domain.trim() !== '') {
          // Only try domain-specific search if no general unpaid invoices found AND domain is valid
          console.log('→ No general unpaid invoices found, trying domain-specific search for:', domain);
          const found = await findRelatedUnpaidInvoice(resolvedClientId, { domain });
          if (found) {
            invoice = found;
            console.log('→ Found unpaid invoice via domain:', found.invoiceid || found.id);
          }
        }
      } catch (err) {
        console.log('✗ Error searching for unpaid invoices:', err.message);
      }
    }
    
    if (!invoice) {
      // No invoice found - provide helpful response based on what was requested
      if (targetInvoiceId) {
        // Specific invoice ID was provided but not found after searching all invoices
        console.log('→ Specific invoice ID not found in all invoices for this client:', targetInvoiceId);
        return {
          success: false,
          error: 'Invoice not found.',
          message: `Invoice #${targetInvoiceId} was not found for this account. Please verify the invoice number or check if it belongs to a different account.`
        };
      } else {
        // No specific invoice ID provided, searched for unpaid invoices but none found
        console.log('→ No unpaid invoices found for client:', resolvedClientId);
        
        if (domain) {
          // Domain-based search found no unpaid invoices
          return { 
            success: false, 
            error: 'No unpaid invoices found.',
            message: 'There are no unpaid invoices for this service. WHMCS will automatically generate a renewal invoice when the service is due (typically 7-14 days before the due date).'
          };
        } else {
          // General search found no unpaid invoices
          return { 
            success: false, 
            error: 'No unpaid invoices found.',
            message: 'There are no unpaid invoices for this account. All invoices appear to be paid or no invoices exist for this account.'
          };
        }
      }
    }
    
    // At this point we have a valid invoice that belongs to the resolved client
    console.log('✓ Invoice found and validated:', invoice.invoiceid || invoice.id);
    
    const status = toMessageStatus(invoice.status);
    const amount = amountFromInvoice(invoice);
    const dueDate = invoice.duedate || null;
    const paidDate = invoice.datepaid || invoice.date_paid || null;
    const invoiceIdOut = invoice.invoiceid || invoice.id;
    const currency = invoice.currencycode; // WHMCS field: currencycode (e.g., "USD", "PKR")
    
    // Check if invoice is overdue
    let isOverdue = false;
    if (dueDate && status !== 'Paid' && status !== 'Cancelled' && status !== 'Refunded') {
      const dueDateObj = new Date(dueDate);
      const now = new Date();
      // Set time to start of day for fair comparison
      dueDateObj.setHours(0, 0, 0, 0);
      now.setHours(0, 0, 0, 0);
      isOverdue = dueDateObj < now;
    }
    
    // Build message based on status and overdue state
    let message;
    if (status === 'Paid') {
      message = paidDate 
        ? `Invoice #${invoiceIdOut} was paid on ${paidDate}.` 
        : `Invoice #${invoiceIdOut} is Paid.`;
    } else if (status === 'Cancelled') {
      message = `Invoice #${invoiceIdOut} has been cancelled and is no longer due.`;
    } else if (status === 'Refunded') {
      message = `Invoice #${invoiceIdOut} has been refunded. No payment is required.`;
    } else if (isOverdue) {
      message = `Invoice #${invoiceIdOut} is overdue. The balance of ${amount} was due on ${dueDate}. Please pay as soon as possible to avoid service interruption.`;
    } else {
      message = `Invoice #${invoiceIdOut} is ${status}, with a balance of ${amount} due${dueDate ? ' by ' + dueDate : ''}.`;
    }
    
    // Add information if original invoice ID was found via comprehensive search
    if (targetInvoiceId && String(targetInvoiceId) !== String(invoiceIdOut)) {
      message += ` Note: Found invoice #${invoiceIdOut} matching your request for #${targetInvoiceId}.`;
    }
    
    const response = { 
      success: true, 
      invoiceId: invoiceIdOut, 
      status, 
      amount, 
      currency,
      dueDate, 
      message
    };
    
    if (status === 'Paid' && paidDate) {
      response.paidDate = paidDate;
    }
    if (isOverdue) {
      response.isOverdue = true;
    }
    if (targetInvoiceId && String(targetInvoiceId) !== String(invoiceIdOut)) {
      response.requestedInvoiceId = targetInvoiceId;
    }
    
    console.log('→ Invoice:', response.invoiceId, 'Status:', response.status, isOverdue ? '(OVERDUE)' : '', 'Amount:', amount);
    console.log('→ FINAL RESPONSE:', JSON.stringify(response, null, 2));
    return response;
  } catch (err) {
    console.log('✗ Error:', err.message);
    console.log('✗ Error stack:', err.stack);
    const errorResponse = {
      success: false,
      error: err.message || 'An error occurred while looking up the invoice'
    };
    console.log('→ ERROR RESPONSE:', JSON.stringify(errorResponse, null, 2));
    return errorResponse;
  }
}

module.exports = {
  invoiceLookup
};
