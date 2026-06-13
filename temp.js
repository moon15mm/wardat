
    const token = localStorage.getItem('wardat_token');
    const role = localStorage.getItem('wardat_role');

    // Theme Logic
    function initTheme() {
      const savedTheme = localStorage.getItem('wardat_theme') || 'dark';
      const btn = document.getElementById('themeToggleBtn');
      if (savedTheme === 'light') {
        document.body.classList.add('light-mode');
        if (btn) btn.textContent = '🌙';
      } else {
        document.body.classList.remove('light-mode');
        if (btn) btn.textContent = '🌞';
      }
    }

    function toggleTheme() {
      const isLight = document.body.classList.toggle('light-mode');
      localStorage.setItem('wardat_theme', isLight ? 'light' : 'dark');
      const btn = document.getElementById('themeToggleBtn');
      if (btn) btn.textContent = isLight ? '🌙' : '🌞';
      
      // Re-fetch or re-draw charts with correct theme colors
      if (lastAnalyticsData) {
        fetchAnalytics();
        if (document.getElementById('subTabPeak').style.display === 'block') {
          renderPeakCharts();
        }
      }
    }

    // Authentication Guard
    if (!token || role !== 'shop') {
      localStorage.clear();
      window.location.href = '/login';
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    window.onload = () => {
      initTheme();
      fetchStats();
      fetchOrders();
      fetchProducts();
      fetchShopDetails();

      // Check for Stripe redirect query params
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('payment') === 'success') {
        alert('🎉 تم تجديد وترقية اشتراك متجرك تلقائياً وتفعيل البوت بنجاح! شكراً لك.');
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (urlParams.get('payment') === 'cancel') {
        alert('⚠️ تم إلغاء عملية الدفع، لم يتم تمديد الاشتراك.');
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };

    let waPollInterval = null;

    function toggleShopAiFields() {
      const provider = document.getElementById('aiProviderInput').value;
      const geminiGroup = document.getElementById('geminiApiKeyInputGroup');
      const openaiGroup = document.getElementById('openaiApiKeyInputGroup');
      geminiGroup.style.display = provider === 'GEMINI' ? 'block' : 'none';
      openaiGroup.style.display = provider === 'GEMINI' ? 'none' : 'block';
    }

    function toggleShopWhatsappFields() {
      const type = document.getElementById('whatsappTypeInput').value;
      const meta = document.getElementById('metaShopFields');
      const ultra = document.getElementById('ultramsgShopFields');
      const metaGuide = document.getElementById('metaGuidePanel');
      
      if (type === 'BUSINESS') {
        meta.style.display = 'block';
        ultra.style.display = 'none';
        document.getElementById('statusSettingsSection').style.display = 'none';
        if (metaGuide) metaGuide.style.display = 'block';
        if (waPollInterval) {
          clearInterval(waPollInterval);
          waPollInterval = null;
        }
      } else {
        meta.style.display = 'none';
        ultra.style.display = 'block';
        document.getElementById('statusSettingsSection').style.display = 'block';
        if (metaGuide) metaGuide.style.display = 'none';
        
        checkWaStatus();
        if (!waPollInterval) {
          waPollInterval = setInterval(checkWaStatus, 5000);
        }
      }
    }

    let chatPollInterval = null;
    let selectedChatPhone = null;
    let chatListData = [];

    function switchTab(tab) {
      document.querySelectorAll('.tabs-nav > .tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

      event.target.classList.add('active');
      
      if (waPollInterval) {
        clearInterval(waPollInterval);
        waPollInterval = null;
      }

      // Stop chat polling when switching away
      if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
      }
      
      if (tab === 'overview') {
        document.getElementById('tabOverview').classList.add('active');
        fetchStats();
        fetchOrders();
        fetchShopDetails();
      } else if (tab === 'products') {
        document.getElementById('tabProducts').classList.add('active');
        fetchProducts();
      } else if (tab === 'settings') {
        document.getElementById('tabSettings').classList.add('active');
        fetchShopDetails();
        fetchBlockedUsers();
      } else if (tab === 'analytics') {
        document.getElementById('tabAnalytics').classList.add('active');
        fetchAnalytics();
      } else if (tab === 'subscription') {
        document.getElementById('tabSubscription').classList.add('active');
        fetchShopDetails();
        calculateSubPrice();
      } else if (tab === 'livechat') {
        document.getElementById('tabLivechat').classList.add('active');
        fetchChatList();
        chatPollInterval = setInterval(fetchChatList, 5000);
      }
    }

    async function fetchStats() {
      try {
        const res = await fetch('/api/shop/stats', { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        document.getElementById('statProducts').textContent = data.totalProducts;
        document.getElementById('statSales').textContent = `${data.totalRevenue.toLocaleString()} ريال`;
        document.getElementById('statOrders').textContent = data.totalOrders;
      } catch (err) {
        console.error('Failed to fetch stats');
      }
    }

    async function fetchShopDetails() {
      try {
        const res = await fetch('/api/shop/details', { headers });
        if (!res.ok) throw new Error();
        const shop = await res.json();

        // Header info
        document.getElementById('shopTitleName').textContent = `لوحة تحكم | ${shop.name}`;
        document.getElementById('shopDomain').textContent = `${shop.subdomain}.wardat.xyz`;

        // Settings inputs
        document.getElementById('shopNameInput').value = shop.name || '';
        document.getElementById('shopEmailInput').value = shop.email || '';
        document.getElementById('logoUrlInput').value = shop.logoUrl || '';
        document.getElementById('ownerPhoneInput').value = shop.ownerPhone || '';
        document.getElementById('whatsappTypeInput').value = shop.whatsappType || 'BUSINESS';
        document.getElementById('whatsappPhoneIdInput').value = shop.whatsappPhoneId || '';
        document.getElementById('whatsappVerifyTokenInput').value = shop.whatsappVerifyToken || '';
        document.getElementById('whatsappTokenInput').value = shop.whatsappToken || '';
        document.getElementById('whatsappAdminGroupIdInput').value = shop.whatsappAdminGroupId || '';
        document.getElementById('stripeSecretKeyInput').value = shop.stripeSecretKey || '';
        document.getElementById('stripeWebhookSecretInput').value = shop.stripeWebhookSecret || '';
        // Auto-fill success/cancel URLs with the site origin if not already set
        const siteOrigin = window.location.origin;
        document.getElementById('stripeSuccessUrlInput').value = shop.stripeSuccessUrl || `${siteOrigin}/success`;
        document.getElementById('stripeCancelUrlInput').value = shop.stripeCancelUrl || `${siteOrigin}/cancel`;
        document.getElementById('aiProviderInput').value = shop.aiProvider || 'OPENAI';
        document.getElementById('geminiApiKeyInput').value = shop.geminiApiKey || '';
        document.getElementById('openaiApiKeyInput').value = shop.openaiApiKey || '';
        document.getElementById('deliveryStartInput').value = shop.deliveryStartHour || '09:00';
        document.getElementById('deliveryEndInput').value = shop.deliveryEndHour || '22:00';
        
        const safeBool = (val, def) => val !== undefined && val !== null ? val : def;
        document.getElementById('enableDeliveryInput').checked = safeBool(shop.enableDelivery, true);
        document.getElementById('enablePickupInput').checked = safeBool(shop.enablePickup, true);
        document.getElementById('enableOnlinePaymentInput').checked = safeBool(shop.enableOnlinePayment, true);
        document.getElementById('enableCashPaymentInput').checked = safeBool(shop.enableCashPayment, false);
        document.getElementById('autoPostStatusInput').checked = safeBool(shop.autoPostStatus, false);
        document.getElementById('autoPostStatusTimeInput').value = shop.autoPostStatusTime || '10:00';

        toggleShopWhatsappFields();
        toggleShopAiFields();

        // Render Subscription Card Info
        const planNames = {
          'TRIAL': '🎁 باقة التجربة',
          'SILVER': '🥈 الباقة الفضية (Silver)',
          'GOLD': '🥇 الباقة الذهبية (Gold)',
          'PLATINUM': '💎 الباقة البلاتينية (Platinum)'
        };
        const planText = planNames[shop.subscriptionPlan] || shop.subscriptionPlan;
        
        // Populate the subscription tab info
        document.getElementById('infoCurrentPlan').textContent = planText;
        document.getElementById('infoExpiryDate').textContent = shop.subscriptionEnd ? new Date(shop.subscriptionEnd).toLocaleDateString('ar-SA') : 'غير محدد';
        document.getElementById('infoStatus').innerHTML = shop.isExpired 
          ? '<span style="color: var(--danger); font-weight: bold;">موقوف (منتهي) ❌</span>' 
          : '<span style="color: var(--success); font-weight: bold;">نشط ومفعّل ✅</span>';

        let subDetailsHtml = '';
        if (shop.isExpired) {
          subDetailsHtml = `<span style="color: var(--danger); font-weight: bold;">${planText}</span><br><span style="font-size: 0.95rem; color: var(--text-sub);">الاشتراك منتهٍ</span>`;
        } else {
          subDetailsHtml = `<span style="color: var(--success); font-weight: bold;">${planText}</span><br><span style="font-size: 0.95rem; color: var(--text-sub);">متبقي ${shop.daysRemaining} يوم</span>`;
        }
        document.getElementById('statSubscription').innerHTML = subDetailsHtml;

        // Pre-select the current plan in the billing tab
        if (shop.subscriptionPlan) {
          selectPlan(shop.subscriptionPlan);
        }

        // Handle Alert Banners
        const banner = document.getElementById('subscriptionBanner');
        if (shop.isExpired) {
          banner.className = 'alert-banner expired';
          banner.style.display = 'flex';
          banner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
              <span>⚠️</span>
              <span><strong>تنبيه هام:</strong> اشتراكك منتهٍ أو موقوف! تم إيقاف ردود البوت وتلقي الطلبات تلقائياً. يرجى التواصل مع الإدارة للتجديد.</span>
            </div>
          `;
        } else if (shop.daysRemaining <= 7) {
          banner.className = 'alert-banner warning';
          banner.style.display = 'flex';
          banner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
              <span>⚠️</span>
              <span><strong>تنبيه:</strong> اشتراكك ينتهي قريباً! متبقي <strong>${shop.daysRemaining}</strong> أيام على انتهاء اشتراكك. يرجى التجديد لتفادي توقف الخدمة.</span>
            </div>
          `;
        } else {
          banner.style.display = 'none';
        }
      } catch (err) {
        console.error('Failed to fetch shop details');
      }
    }

    async function checkWaStatus() {
      try {
        const res = await fetch('/api/shop/whatsapp/status', { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        const statusEl = document.getElementById('waConnectionStatus');
        const qrContainer = document.getElementById('waQrCodeContainer');
        const btnGen = document.getElementById('btnWaGenerateQr');
        const btnLogout = document.getElementById('btnWaLogout');

        if (data.status === 'CONNECTED') {
          statusEl.textContent = 'الحالة: متصل بنجاح ✅';
          statusEl.style.color = 'var(--success)';
          qrContainer.style.display = 'none';
          btnGen.style.display = 'none';
          btnLogout.style.display = 'inline-block';
          
          if (waPollInterval) {
            clearInterval(waPollInterval);
            waPollInterval = null;
          }
        } else if (data.status === 'QR_READY') {
          statusEl.textContent = 'الحالة: جاهز للمسح 📷';
          statusEl.style.color = 'var(--warning)';
          btnGen.style.display = 'inline-block';
          btnGen.textContent = 'تحديث كود QR';
          btnLogout.style.display = 'inline-block';
          fetchWaQrImage();
        } else if (data.status === 'CONNECTING') {
          statusEl.textContent = 'الحالة: جاري الاتصال... ⏳';
          statusEl.style.color = '#38ef7d';
          qrContainer.style.display = 'none';
          btnGen.style.display = 'none';
          btnLogout.style.display = 'inline-block';
        } else {
          statusEl.textContent = 'الحالة: غير متصل ❌';
          statusEl.style.color = 'var(--danger)';
          qrContainer.style.display = 'none';
          btnGen.style.display = 'inline-block';
          btnGen.textContent = 'توليد كود QR';
          btnLogout.style.display = 'none';
          
          if (waPollInterval) {
            clearInterval(waPollInterval);
            waPollInterval = null;
          }
        }
      } catch (err) {
        console.error('Error checking WhatsApp status', err);
      }
    }

    async function fetchWaQrImage() {
      try {
        const res = await fetch('/api/shop/whatsapp/qr', { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();

        if (data.qr) {
          document.getElementById('waQrImage').src = data.qr;
          document.getElementById('waQrCodeContainer').style.display = 'flex';
        }
      } catch (err) {
        console.error('Error fetching QR image', err);
      }
    }

    async function loadWaQrCode() {
      const statusEl = document.getElementById('waConnectionStatus');
      statusEl.textContent = 'جاري التشغيل وتوليد الكود... ⏳';
      statusEl.style.color = '#38ef7d';

      try {
        const res = await fetch('/api/shop/whatsapp/qr', { headers });
        if (!res.ok) throw new Error();
        
        if (!waPollInterval) {
          waPollInterval = setInterval(checkWaStatus, 5000);
        }
        setTimeout(checkWaStatus, 3000);
      } catch (err) {
        alert('فشل في تشغيل جلسة واتساب');
        checkWaStatus();
      }
    }

    async function logoutWaSession() {
      if (!confirm('هل أنت متأكد من رغبتك في فصل الاتصال برقم الواتساب؟')) return;

      try {
        const res = await fetch('/api/shop/whatsapp/logout', { method: 'POST', headers });
        if (!res.ok) throw new Error();
        
        alert('تم فصل الاتصال بنجاح! 🔌');
        checkWaStatus();
      } catch (err) {
        alert('فشل في فصل الاتصال');
      }
    }

    async function saveSettings(e) {
      e.preventDefault();
      
      const payload = {
        name: document.getElementById('shopNameInput').value.trim(),
        email: document.getElementById('shopEmailInput').value.trim().toLowerCase(),
        logoUrl: document.getElementById('logoUrlInput').value.trim() || null,
        ownerPhone: document.getElementById('ownerPhoneInput').value.trim() || null,
        whatsappType: document.getElementById('whatsappTypeInput').value,
        whatsappPhoneId: document.getElementById('whatsappPhoneIdInput').value.trim() || null,
        whatsappVerifyToken: document.getElementById('whatsappVerifyTokenInput').value.trim() || null,
        whatsappToken: document.getElementById('whatsappTokenInput').value.trim() || null,
        whatsappAdminGroupId: document.getElementById('whatsappAdminGroupIdInput').value.trim() || null,
        stripeSecretKey: document.getElementById('stripeSecretKeyInput').value.trim() || null,
        stripeWebhookSecret: document.getElementById('stripeWebhookSecretInput').value.trim() || null,
        stripeSuccessUrl: document.getElementById('stripeSuccessUrlInput').value.trim() || null,
        stripeCancelUrl: document.getElementById('stripeCancelUrlInput').value.trim() || null,
        aiProvider: document.getElementById('aiProviderInput').value,
        geminiApiKey: document.getElementById('geminiApiKeyInput').value.trim() || null,
        openaiApiKey: document.getElementById('openaiApiKeyInput').value.trim() || null,
        deliveryStartHour: document.getElementById('deliveryStartInput').value,
        deliveryEndHour: document.getElementById('deliveryEndInput').value,
        enableDelivery: document.getElementById('enableDeliveryInput').checked,
        enablePickup: document.getElementById('enablePickupInput').checked,
        enableOnlinePayment: document.getElementById('enableOnlinePaymentInput').checked,
        enableCashPayment: document.getElementById('enableCashPaymentInput').checked,
        autoPostStatus: document.getElementById('autoPostStatusInput').checked,
        autoPostStatusTime: document.getElementById('autoPostStatusTimeInput').value,
      };

      const newPassword = document.getElementById('shopPasswordInput').value;
      if (newPassword) {
        payload.password = newPassword;
      }

      try {
        const res = await fetch('/api/shop/details', {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error();
        alert('تم تحديث إعدادات متجرك بنجاح! ✅');
        document.getElementById('shopPasswordInput').value = '';
        fetchShopDetails();
      } catch (err) {
        alert('عذراً، فشل تحديث الإعدادات');
      }
    }

    async function fetchOrders() {
      try {
        const res = await fetch('/api/shop/orders', { headers });
        if (!res.ok) throw new Error();
        const orders = await res.json();

        const tbody = document.getElementById('ordersTableBody');
        tbody.innerHTML = '';

        if (orders.length === 0) {
          tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; color: var(--text-sub);">لا يوجد طلبات مسجلة للمحل حالياً</td></tr>`;
          return;
        }

        const STATUS_META = {
          PENDING:   { cls: 'pending',   label: 'معلّق بالدفع' },
          CONFIRMED: { cls: 'confirmed', label: 'مدفوع ومؤكد' },
          DELIVERED: { cls: 'confirmed', label: 'تم التوصيل' },
          CANCELLED: { cls: 'failed',    label: 'ملغى' },
          FAILED:    { cls: 'failed',    label: 'دفع فاشل' },
        };
        const STATUS_OPTS = [['PENDING','معلّق'],['CONFIRMED','مؤكد'],['DELIVERED','تم التوصيل'],['CANCELLED','إلغاء'],['FAILED','فاشل']];

        orders.forEach(order => {
          const meta = STATUS_META[order.paymentStatus] || STATUS_META.PENDING;
          const opts = STATUS_OPTS.map(([v,l]) => `<option value="${v}" ${order.paymentStatus===v?'selected':''}>${l}</option>`).join('');

          const row = document.createElement('tr');
          row.innerHTML = `
            <td style="font-family: 'Outfit'; font-weight:bold;">${order.id}</td>
            <td>${order.customerName}</td>
            <td style="font-family: 'Outfit';">${order.customerPhone}</td>
            <td>${order.recipientName}</td>
            <td style="font-weight: 500;">${order.productName}</td>
            <td style="font-family: 'Outfit'; color: var(--pink-glow); font-weight: bold;">${order.price}</td>
            <td><span class="status-tag ${meta.cls}">${meta.label}</span></td>
            <td style="font-family: 'Outfit'; font-size: 0.8rem; color: var(--text-sub);">${order.cardLast4 ? 'بطاقة: ' + order.cardLast4 : 'لا يوجد'}</td>
            <td>${order.locationUrl ? `<a href="${order.locationUrl}" target="_blank" style="color:var(--purple-glow); font-size: 0.85rem; font-weight:bold;">عرض الخريطة 📍</a>` : '—'}</td>
            <td style="font-size: 0.85rem; color: var(--text-sub);">${new Date(order.timestamp).toLocaleString('ar-SA')}</td>
            <td style="white-space:nowrap;">
              <select onchange="updateOrderStatus('${order.id}', this.value)" style="padding:5px 8px; border-radius:8px; background:rgba(0,0,0,0.3); color:var(--text-main); border:1px solid var(--glass-border); font-size:0.8rem;">${opts}</select>
              <button onclick="deleteOrder('${order.id}')" title="حذف الطلب" style="margin-right:6px; background:transparent; border:1px solid rgba(255,75,75,0.4); color:#ff6b6b; border-radius:8px; padding:5px 9px; cursor:pointer; font-size:0.8rem;">🗑️</button>
            </td>
          `;
          tbody.appendChild(row);
        });
      } catch (err) {
        document.getElementById('ordersTableBody').innerHTML = `<tr><td colspan="11" style="text-align: center; color: var(--danger);">فشل تحميل سجل الطلبات</td></tr>`;
      }
    }

    async function updateOrderStatus(id, status) {
      try {
        const res = await fetch('/api/shop/orders/' + id, {
          method: 'PUT', headers, body: JSON.stringify({ status })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'فشل'); }
        fetchOrders();
        if (typeof fetchStats === 'function') fetchStats();
      } catch (e) { alert(e.message); }
    }

    async function deleteOrder(id) {
      if (!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً؟')) return;
      try {
        const res = await fetch('/api/shop/orders/' + id, { method: 'DELETE', headers });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'فشل الحذف'); }
        fetchOrders();
        if (typeof fetchStats === 'function') fetchStats();
      } catch (e) { alert(e.message); }
    }

    async function fetchProducts() {
      try {
        const res = await fetch('/api/shop/products', { headers });
        if (!res.ok) throw new Error();
        const products = await res.json();

        const grid = document.getElementById('productGrid');
        grid.innerHTML = '';

        if (products.length === 0) {
          grid.innerHTML = `<p style="grid-column: 1/-1; text-align:center; color: var(--text-sub); padding:40px;">لا يوجد منتجات معروضة حالياً. اضغط على "إضافة منتج جديد" للبدء!</p>`;
          return;
        }

        products.forEach(p => {
          const card = document.createElement('div');
          card.className = 'product-card';
          
          const stockText = p.stock !== undefined 
            ? (p.stock > 0 ? `<span style="font-size:0.75rem; color:var(--success);">متبقي: ${p.stock} حبة</span>` : `<span style="font-size:0.75rem; color:var(--danger); font-weight:bold;">نفدت الكمية ❌</span>`)
            : '';

          card.innerHTML = `
            <img class="product-img" src="${p.imageUrl || 'https://images.unsplash.com/photo-1561181286-d3fee7d55364?auto=format&fit=crop&q=80&w=400'}" alt="${p.name}">
            <div class="product-details">
              <div class="product-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>${p.name}</span>
                ${stockText}
              </div>
              <div class="product-desc">${p.description || 'لا يوجد تفاصيل إضافية للمنتج.'}</div>
              <div class="product-meta">
                <span class="product-price">${p.price} ر.س</span>
                <div class="product-actions">
                  <button class="btn-edit" onclick="postProductStatus('${p.id}')" title="نشر كحالة واتساب" style="color: #25D366; border-color: #25D366;"><i class="fab fa-whatsapp"></i> الحالة</button>
                  <button class="btn-edit" onclick="editProduct('${p.id}', '${p.name}', '${p.description.replace(/'/g, "\\'")}', ${p.price}, '${p.imageUrl}', '${p.category}', ${p.available}, ${p.stock || 0})">تعديل</button>
                  <button class="btn-p-delete" onclick="deleteProduct('${p.id}', '${p.name}')">حذف</button>
                </div>
              </div>
            </div>
          `;
          grid.appendChild(card);
        });
      } catch (err) {
        console.error('Failed to fetch products');
      }
    }

    async function postProductStatus(id) {
      if (!confirm('هل تريد نشر هذا المنتج كحالة واتساب الآن للعملاء؟\nملاحظة: هذا يتطلب استخدام الواتساب العادي (عبر مسح الكود).')) return;
      try {
        const res = await fetch(`/api/shop/products/${id}/status`, { method: 'POST', headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل النشر');
        alert('✅ ' + data.message);
      } catch (e) {
        alert('❌ خطأ: ' + e.message);
      }
    }

    function openProductModal() {
      document.getElementById('modalTitle').textContent = 'إضافة منتج جديد للمتجر';
      document.getElementById('productId').value = '';
      document.getElementById('productForm').reset();
      document.getElementById('productModal').style.display = 'flex';
    }

    function closeProductModal() {
      document.getElementById('productModal').style.display = 'none';
    }

    function editProduct(id, name, desc, price, img, category, available, stock) {
      document.getElementById('modalTitle').textContent = 'تعديل منتج المتجر';
      document.getElementById('productId').value = id;
      document.getElementById('pName').value = name;
      document.getElementById('pDescription').value = desc === 'undefined' ? '' : desc;
      document.getElementById('pPrice').value = price;
      document.getElementById('pCategory').value = category === 'undefined' ? '' : category;
      document.getElementById('pImageUrl').value = img === 'undefined' ? '' : img;
      document.getElementById('pAvailable').checked = available;
      document.getElementById('pStock').value = stock !== undefined ? stock : 10;
      document.getElementById('productModal').style.display = 'flex';
    }

    async function saveProduct(e) {
      e.preventDefault();

      const id = document.getElementById('productId').value;
      const payload = {
        name: document.getElementById('pName').value.trim(),
        description: document.getElementById('pDescription').value.trim(),
        price: parseFloat(document.getElementById('pPrice').value),
        category: document.getElementById('pCategory').value.trim(),
        imageUrl: document.getElementById('pImageUrl').value.trim(),
        available: document.getElementById('pAvailable').checked,
        stock: parseInt(document.getElementById('pStock').value)
      };

      const url = id ? `/api/shop/products/${id}` : '/api/shop/products';
      const method = id ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error();
        closeProductModal();
        fetchProducts();
      } catch (err) {
        alert('فشل في حفظ بيانات المنتج');
      }
    }

    async function deleteProduct(id, name) {
      if (!confirm(`هل أنت متأكد من رغبتك في حذف المنتج "${name}"؟`)) return;

      try {
        const res = await fetch(`/api/shop/products/${id}`, {
          method: 'DELETE',
          headers
        });

        if (!res.ok) throw new Error();
        fetchProducts();
      } catch (err) {
        alert('فشل في حذف المنتج');
      }
    }
    let selectedPlan = 'GOLD';
    let selectedDuration = 1;

    // Plan pricing fetched from the platform (admin-editable). Falls back to defaults.
    let PLAN_PRICES = { SILVER: 50, GOLD: 150, PLATINUM: 300 };
    let PLAN_DISCOUNTS = { 3: 5, 6: 10, 12: 20 };

    async function loadPlanPricing() {
      try {
        const res = await fetch('/api/plans');
        if (!res.ok) return;
        const data = await res.json();
        if (data.prices) PLAN_PRICES = data.prices;
        if (data.discountPercents) PLAN_DISCOUNTS = data.discountPercents;
        // Update the price labels on the plan cards
        const map = { SILVER: 'planPriceSILVER', GOLD: 'planPriceGOLD', PLATINUM: 'planPricePLATINUM' };
        Object.keys(map).forEach(p => {
          const el = document.getElementById(map[p]);
          if (el && PLAN_PRICES[p] != null) el.textContent = PLAN_PRICES[p];
        });
        calculateSubPrice();
      } catch (e) {}
    }
    loadPlanPricing();

    function selectPlan(plan) {
      selectedPlan = plan;
      document.querySelectorAll('.plan-card').forEach(card => {
        if (card.dataset.plan === plan) {
          card.classList.add('active');
        } else {
          card.classList.remove('active');
        }
      });
      calculateSubPrice();
    }

    function selectDuration(duration) {
      selectedDuration = parseInt(duration);
      document.querySelectorAll('.duration-pill').forEach(pill => {
        if (parseInt(pill.dataset.months) === selectedDuration) {
          pill.classList.add('active');
        } else {
          pill.classList.remove('active');
        }
      });
      calculateSubPrice();
    }

    function calculateSubPrice() {
      const plan = selectedPlan;
      const duration = selectedDuration;
      
      let monthlyPrice = PLAN_PRICES[plan] != null ? PLAN_PRICES[plan] : 150;
      let planText = plan === 'SILVER' ? 'الباقة الفضية' : plan === 'PLATINUM' ? 'الباقة البلاتينية' : 'الباقة الذهبية';

      const discPct = PLAN_DISCOUNTS[duration] || 0;
      const discount = discPct / 100;
      const discountText = discPct ? ` (خصم ${discPct}%${duration === 12 ? ' 🔥' : ''})` : '';

      const totalPrice = Math.round(monthlyPrice * duration * (1 - discount));
      document.getElementById('subTotalPriceText').textContent = `${totalPrice} ريال`;
      document.getElementById('subPriceBreakdown').textContent = `${planText} لمدة ${duration} أشهر${discountText}`;
    }

    async function checkoutSubscription(e) {
      e.preventDefault();
      
      const plan = selectedPlan;
      const durationMonths = selectedDuration;
      
      const btn = e.target.querySelector('button[type="submit"]');
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = 'جاري التوجيه للدفع... ⏳';

      try {
        const res = await fetch('/api/shop/subscription/checkout', {
          method: 'POST',
          headers,
          body: JSON.stringify({ plan, durationMonths })
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل في الانتقال للدفع');
        
        if (data.url) {
          window.location.href = data.url;
        }
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    }
    let salesChartInstance = null;
    let hourlyChartInstance = null;
    let weekdayChartInstance = null;
    let lastAnalyticsData = null;

    function switchSubAnalyticsTab(subTab) {
      document.querySelectorAll('.sub-analytics-content').forEach(el => el.style.display = 'none');
      document.querySelectorAll('#tabAnalytics .tab-btn').forEach(btn => btn.classList.remove('active'));

      if (subTab === 'sales') {
        document.getElementById('subTabSales').style.display = 'block';
        document.getElementById('subTabSalesBtn').classList.add('active');
      } else if (subTab === 'peak') {
        document.getElementById('subTabPeak').style.display = 'block';
        document.getElementById('subTabPeakBtn').classList.add('active');
        setTimeout(renderPeakCharts, 50);
      } else if (subTab === 'stock') {
        document.getElementById('subTabStock').style.display = 'block';
        document.getElementById('subTabStockBtn').classList.add('active');
      }
    }

    async function fetchAnalytics() {
      try {
        const res = await fetch('/api/shop/analytics', { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();
        lastAnalyticsData = data;

        // 1. Sales Tab metrics
        document.getElementById('statAOV').textContent = `${data.summary.aov.toLocaleString()} ر.س`;
        
        const growth = data.predictiveAnalytics.growthRate;
        const growthEl = document.getElementById('statGrowth');
        if (growth > 0) {
          growthEl.textContent = `+${growth}% 📈`;
          growthEl.style.color = 'var(--success)';
        } else if (growth < 0) {
          growthEl.textContent = `${growth}% 📉`;
          growthEl.style.color = 'var(--danger)';
        } else {
          growthEl.textContent = `0% ➖`;
          growthEl.style.color = 'var(--text-sub)';
        }

        document.getElementById('statBusiestDay').textContent = data.predictiveAnalytics.busiestDay;
        document.getElementById('forecastedRevenue').textContent = `${data.predictiveAnalytics.forecastedSalesNextWeek.toLocaleString()} ر.س`;
        document.getElementById('forecastedRevenueMonth').textContent = `${data.predictiveAnalytics.forecastedSalesNextMonth.toLocaleString()} ر.س`;

        // Popular products
        const tbody = document.getElementById('productSalesTableBody');
        tbody.innerHTML = '';
        if (data.salesByProduct.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-sub);">لا يوجد مبيعات مسجلة للمنتجات بعد</td></tr>';
        } else {
          data.salesByProduct.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
              <td style="font-weight: bold;">${item.productName}</td>
              <td style="font-family: \'Outfit\';">${item.count}</td>
              <td style="font-family: \'Outfit\'; color: var(--pink-glow); font-weight: bold;">${item.totalRevenue.toLocaleString()}</td>
            `;
            tbody.appendChild(row);
          });
        }

        // Daily chart
        const labels = data.dailySales.map(d => {
          const date = new Date(d.date);
          return date.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' });
        });
        const chartData = data.dailySales.map(d => d.revenue);

        const isLight = document.body.classList.contains('light-mode');
        const gridColor = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.05)';
        const tickColor = isLight ? '#5f6368' : '#b1a9c3';

        if (salesChartInstance) salesChartInstance.destroy();
        const ctx = document.getElementById('salesChart').getContext('2d');
        salesChartInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'المبيعات اليومية (ريال)',
              data: chartData,
              borderColor: '#ff2d81',
              backgroundColor: isLight ? 'rgba(255, 45, 129, 0.05)' : 'rgba(255, 45, 129, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointBackgroundColor: '#8e2de2',
              pointBorderColor: '#fff',
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: tickColor, font: { family: 'Tajawal' } } },
              y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { family: 'Tajawal' } } }
            }
          }
        });

        // 2. Peak & Loyalty metrics
        document.getElementById('statUniqueCustomers').textContent = data.summary.loyalty.uniqueCustomers;
        document.getElementById('statRepeatCustomers').textContent = data.summary.loyalty.repeatCustomers;
        document.getElementById('statLoyaltyRate').textContent = `${data.summary.loyalty.repeatCustomerRate}%`;

        // 3. Stock metrics
        const alertsList = document.getElementById('stockAlertsList');
        alertsList.innerHTML = '';
        if (data.predictiveAnalytics.restockAlerts.length === 0) {
          alertsList.innerHTML = '<li style="color: var(--success); list-style-type: none; margin-bottom:8px;">جميع مستويات المخزون ممتازة وبحالة مستقرة! ✅</li>';
        } else {
          data.predictiveAnalytics.restockAlerts.forEach(alert => {
            const li = document.createElement('li');
            li.innerHTML = alert;
            li.style.marginBottom = '8px';
            alertsList.appendChild(li);
          });
        }

        // Product projections table
        const stockTbody = document.getElementById('productStockProjectionsTableBody');
        stockTbody.innerHTML = '';
        if (data.productProjections.length === 0) {
          stockTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-sub);">لا يوجد منتجات مسجلة في المتجر</td></tr>';
        } else {
          data.productProjections.forEach(item => {
            const row = document.createElement('tr');
            const colorClass = item.stock <= 3 ? 'color: var(--danger); font-weight: bold;' : '';
            row.innerHTML = `
              <td style="font-weight: bold;">${item.name}</td>
              <td style="font-family: \'Outfit\'; ${colorClass}">${item.stock} حبة</td>
              <td style="font-family: \'Outfit\';">${item.velocity} حبة / يوم</td>
              <td style="font-weight: 500; color: ${item.stock <= 3 ? 'var(--danger)' : (item.daysToStockOut.includes('أيام') ? 'var(--warning)' : 'var(--success)')};">${item.daysToStockOut}</td>
            `;
            stockTbody.appendChild(row);
          });
        }

        // VIP Customers
        const vipTbody = document.getElementById('vipCustomersTableBody');
        vipTbody.innerHTML = '';
        if (data.topCustomers && data.topCustomers.length === 0) {
          vipTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-sub);">لا يوجد بيانات كافية</td></tr>';
        } else if (data.topCustomers) {
          data.topCustomers.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
              <td style="font-family: \'Outfit\';">${formatPhone(item.phone)}</td>
              <td style="font-weight: bold; color: var(--success);">${item.name}</td>
              <td style="font-family: \'Outfit\';">${item.count}</td>
              <td style="font-family: \'Outfit\'; color: var(--pink-glow); font-weight: bold;">${item.spent.toLocaleString()}</td>
            `;
            vipTbody.appendChild(row);
          });
        }

        // Stagnant Products
        const stagnantTbody = document.getElementById('stagnantProductsTableBody');
        stagnantTbody.innerHTML = '';
        if (data.stagnantProducts && data.stagnantProducts.length === 0) {
          stagnantTbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--success); font-weight: bold;">ممتاز! لا يوجد منتجات راكدة.</td></tr>';
        } else if (data.stagnantProducts) {
          data.stagnantProducts.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
              <td style="font-weight: bold;">${item.name}</td>
              <td style="font-family: \'Outfit\'; color: var(--danger); font-weight: bold;">${item.stock} حبة</td>
              <td style="font-size: 0.8rem; color: var(--warning);">يفضل عمل خصم 10% أو عرض ترويجي</td>
            `;
            stagnantTbody.appendChild(row);
          });
        }

        // Fulfillment Breakdown Chart
        if (data.fulfillmentBreakdown) {
          const fCtx = document.getElementById('fulfillmentChart').getContext('2d');
          if (window.fulfillmentChartInstance) window.fulfillmentChartInstance.destroy();
          window.fulfillmentChartInstance = new Chart(fCtx, {
            type: 'doughnut',
            data: {
              labels: ['توصيل', 'استلام من المحل'],
              datasets: [{
                data: [data.fulfillmentBreakdown.delivery, data.fulfillmentBreakdown.pickup],
                backgroundColor: ['#8e2de2', '#ff2d81'],
                borderWidth: 0
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: 'bottom', labels: { color: tickColor, font: { family: 'Tajawal' } } }
              }
            }
          });
        }

      } catch (err) {
        console.error('Failed to fetch analytics data');
      }
    }

    function renderPeakCharts() {
      if (!lastAnalyticsData) return;
      const data = lastAnalyticsData;

      // Hourly Chart
      const hoursLabels = data.salesByHour.map(h => h.hour);
      const hoursData = data.salesByHour.map(h => h.count);

      const isLight = document.body.classList.contains('light-mode');
      const gridColor = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.05)';
      const tickColor = isLight ? '#5f6368' : '#b1a9c3';

      if (hourlyChartInstance) hourlyChartInstance.destroy();
      const hourlyCtx = document.getElementById('hourlyChart').getContext('2d');
      hourlyChartInstance = new Chart(hourlyCtx, {
        type: 'bar',
        data: {
          labels: hoursLabels,
          datasets: [{
            label: 'عدد الطلبات',
            data: hoursData,
            backgroundColor: isLight ? 'rgba(142, 45, 226, 0.7)' : 'rgba(142, 45, 226, 0.6)',
            borderColor: '#8e2de2',
            borderWidth: 1.5,
            borderRadius: 5,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: tickColor, font: { family: 'Tajawal', size: 9 } } },
            y: { grid: { color: gridColor }, ticks: { color: tickColor, stepSize: 1 } }
          }
        }
      });

      // Weekday Chart
      const weekdayLabels = data.salesByDayOfWeek.map(d => d.dayName);
      const weekdayData = data.salesByDayOfWeek.map(d => d.revenue);

      if (weekdayChartInstance) weekdayChartInstance.destroy();
      const weekdayCtx = document.getElementById('weekdayChart').getContext('2d');
      weekdayChartInstance = new Chart(weekdayCtx, {
        type: 'bar',
        data: {
          labels: weekdayLabels,
          datasets: [{
            label: 'إيرادات المبيعات (ريال)',
            data: weekdayData,
            backgroundColor: isLight ? 'rgba(255, 45, 129, 0.7)' : 'rgba(255, 45, 129, 0.6)',
            borderColor: '#ff2d81',
            borderWidth: 1.5,
            borderRadius: 5,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: tickColor, font: { family: 'Tajawal' } } },
            y: { grid: { color: gridColor }, ticks: { color: tickColor } }
          }
        }
      });
    }

    // ==================== LIVE CHAT FUNCTIONS ====================

    let currentChatFilter = 'ACTIVE';

    function setChatFilter(filterType) {
      currentChatFilter = filterType;
      document.getElementById('btnFilterActive').style.background = filterType === 'ACTIVE' ? 'var(--purple-glow)' : 'transparent';
      document.getElementById('btnFilterActive').style.color = filterType === 'ACTIVE' ? '#fff' : 'var(--text-sub)';
      
      document.getElementById('btnFilterArchived').style.background = filterType === 'ARCHIVED' ? 'var(--purple-glow)' : 'transparent';
      document.getElementById('btnFilterArchived').style.color = filterType === 'ARCHIVED' ? '#fff' : 'var(--text-sub)';
      
      document.getElementById('chatSidebarTitle').textContent = filterType === 'ACTIVE' ? '💬 المحادثات النشطة' : '🗄️ الأرشيف';
      renderChatList();
    }

    function renderChatList() {
      const listEl = document.getElementById('chatList');
      const filteredChats = chatListData.filter(c => currentChatFilter === 'ARCHIVED' ? c.state === 'ARCHIVED' : c.state !== 'ARCHIVED');
      
      document.getElementById('chatCount').textContent = filteredChats.length;

      if (filteredChats.length === 0) {
          listEl.innerHTML = `
            <div class="chat-empty-state" style="padding: 30px;">
              <div class="chat-empty-icon">💭</div>
              <p>لا توجد محادثات نشطة حالياً</p>
            </div>
          `;
          return;
        }

        listEl.innerHTML = filteredChats.map(chat => {
          const isActive = selectedChatPhone === chat.phone;
          const timeAgo = getTimeAgo(parseInt(chat.lastActivity));
          const preview = chat.lastMessage ? (chat.lastMessage.length > 40 ? chat.lastMessage.substring(0, 40) + '...' : chat.lastMessage) : 'لا توجد رسائل';
          const roleIcon = chat.lastMessageRole === 'user' ? '👤' : '🤖';
          const botBadge = chat.botPaused
            ? '<span class="chat-bot-badge paused">⏸ موقوف</span>'
            : (chat.state === 'ARCHIVED' ? '<span class="chat-bot-badge paused" style="background:rgba(255,255,255,0.1); color:var(--text-sub); border-color:rgba(255,255,255,0.2);">🗄️ مؤرشف</span>' : '<span class="chat-bot-badge active">🤖 نشط</span>');

          return `
            <div class="chat-list-item ${isActive ? 'active' : ''}" onclick="openChat('${chat.phone}')">
              <div class="chat-avatar">${chat.phone.slice(-2)}</div>
              <div class="chat-item-info">
                <div class="chat-item-phone">${formatPhone(chat.phone)}</div>
                <div class="chat-item-preview">${roleIcon} ${preview}</div>
              </div>
              <div class="chat-item-meta">
                ${botBadge}
                <span style="font-size: 0.65rem; color: var(--text-sub);">${timeAgo}</span>
              </div>
            </div>
          `;
        }).join('');

        // If a chat is currently open, refresh its messages too
        if (selectedChatPhone) {
          fetchChatMessages(selectedChatPhone);
        }
    }

    async function fetchChatList() {
      try {
        const res = await fetch('/api/shop/chats', { headers });
        if (!res.ok) throw new Error();
        chatListData = await res.json();
        renderChatList();
      } catch (err) {
        console.error('Failed to fetch chat list', err);
      }
    }

    function formatPhone(phone) {
      if (!phone) return '-';
      if (phone.startsWith('lid')) {
        return phone.replace(/@.*/, '');
      }
      if (phone.length > 10 && phone.includes('@')) {
        return '+' + phone.replace(/@.*/, '');
      }
      return phone;
    }

    function getTimeAgo(timestamp) {
      const diff = Date.now() - timestamp;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'الآن';
      if (mins < 60) return `منذ ${mins} د`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `منذ ${hours} س`;
      const days = Math.floor(hours / 24);
      return `منذ ${days} يوم`;
    }

    async function openChat(phone) {
      selectedChatPhone = phone;

      // Mobile: show chat view
      document.getElementById('chatContainer').classList.add('chat-view-open');

      // Show header, messages, input
      document.getElementById('chatHeader').style.display = 'flex';
      document.getElementById('chatMessages').style.display = 'flex';
      document.getElementById('chatInputArea').style.display = 'flex';
      document.getElementById('chatPlaceholder').style.display = 'none';

      document.getElementById('chatHeaderPhone').textContent = formatPhone(phone);

      // Update active in list
      document.querySelectorAll('.chat-list-item').forEach(el => el.classList.remove('active'));
      event.currentTarget?.classList?.add('active');

      await fetchChatMessages(phone);
    }

    function closeChatView() {
      selectedChatPhone = null;
      document.getElementById('chatContainer').classList.remove('chat-view-open');
      document.getElementById('chatHeader').style.display = 'none';
      document.getElementById('chatMessages').style.display = 'none';
      document.getElementById('chatInputArea').style.display = 'none';
      document.getElementById('chatPlaceholder').style.display = 'flex';
      document.querySelectorAll('.chat-list-item').forEach(el => el.classList.remove('active'));
    }

    async function fetchChatMessages(phone) {
      try {
        const res = await fetch(`/api/shop/chats/${encodeURIComponent(phone)}`, { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();

        // Update header state
        const stateLabels = {
          'GREETING': 'ترحيب',
          'BROWSING': 'يتصفح',
          'SELECTING_PRODUCT': 'يختار منتج',
          'COLLECTING_NAME': 'يجمع الاسم',
          'COLLECTING_PHONE': 'يجمع الرقم',
          'COLLECTING_RECIPIENT': 'يجمع بيانات المستلم',
          'COLLECTING_LOCATION': 'يجمع الموقع',
          'CONFIRMING_ORDER': 'تأكيد الطلب',
          'AWAITING_PAYMENT': 'في انتظار الدفع',
        };
        document.getElementById('chatHeaderState').textContent = `الحالة: ${stateLabels[data.state] || data.state}`;

        // Update toggle switch
        const toggle = document.getElementById('botToggle');
        toggle.checked = data.botPaused;
        document.getElementById('toggleLabel').textContent = data.botPaused ? 'البوت موقوف ⏸' : 'البوت نشط 🤖';

        // Render messages
        const messagesEl = document.getElementById('chatMessages');
        if (!data.messages || data.messages.length === 0) {
          messagesEl.innerHTML = `
            <div class="chat-empty-state">
              <div class="chat-empty-icon">💬</div>
              <p>لا توجد رسائل بعد في هذه المحادثة</p>
            </div>
          `;
          return;
        }

        messagesEl.innerHTML = data.messages.map(msg => {
          const isManual = msg.content && msg.content.startsWith('[تدخل يدوي]');
          const isUser = msg.role === 'user';
          let bubbleClass = isUser ? 'user' : (isManual ? 'manual' : 'assistant');
          let label = isUser ? '👤 العميل' : (isManual ? '👨‍💼 تدخل يدوي' : '🤖 البوت');
          let content = isManual ? msg.content.replace('[تدخل يدوي] ', '') : msg.content;

          return `
            <div class="chat-bubble ${bubbleClass}">
              <div class="chat-bubble-label">${label}</div>
              ${escapeHtml(content)}
            </div>
          `;
        }).join('');

        // Scroll to bottom
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (err) {
        console.error('Failed to fetch chat messages', err);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function toggleBotForChat() {
      if (!selectedChatPhone) return;

      try {
        const res = await fetch(`/api/shop/chats/${encodeURIComponent(selectedChatPhone)}/toggle-bot`, {
          method: 'POST',
          headers,
        });
        if (!res.ok) throw new Error();
        const data = await res.json();

        document.getElementById('toggleLabel').textContent = data.botPaused ? 'البوت موقوف ⏸' : 'البوت نشط 🤖';

        // Refresh list to update badges
        fetchChatList();
      } catch (err) {
        console.error('Failed to toggle bot', err);
        alert('فشل في تغيير حالة البوت');
      }
    }

    async function sendChatMsg() {
      if (!selectedChatPhone) return;

      const input = document.getElementById('chatMsgInput');
      const message = input.value.trim();
      if (!message) return;

      const sendBtn = document.getElementById('chatSendBtn');
      sendBtn.disabled = true;
      input.value = '';

      try {
        const res = await fetch(`/api/shop/chats/${encodeURIComponent(selectedChatPhone)}/send`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'فشل الإرسال');
        }

        // Refresh messages and list
        await fetchChatMessages(selectedChatPhone);
        await fetchChatList();
      } catch (err) {
        alert('خطأ: ' + err.message);
        input.value = message;
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    async function fetchBlockedUsers() {
      try {
        const res = await fetch('/api/shop/blocked-customers', { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        const tbody = document.getElementById('blockedUsersTableBody');
        if (data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-sub);">لا يوجد عملاء محظورين.</td></tr>';
          return;
        }

        tbody.innerHTML = data.map(item => `
          <tr>
            <td style="font-family: 'Outfit';">${formatPhone(item.phone)}</td>
            <td>${new Date(item.createdAt).toLocaleString('ar-SA')}</td>
            <td>${escapeHtml(item.reason || '-')}</td>
            <td>
              <button class="btn-cancel" onclick="unblockUser('${item.phone}')" style="padding: 4px 10px; font-size: 0.8rem;">إزالة الحظر</button>
            </td>
          </tr>
        `).join('');
      } catch (err) {
        console.error('Failed to load blocked users');
      }
    }

    async function unblockUser(phone) {
      if (!confirm('تأكيد إزالة الحظر عن هذا العميل ليتمكن من الطلب مجدداً؟')) return;

      try {
        const res = await fetch(`/api/shop/chats/${encodeURIComponent(phone)}/block`, {
          method: 'DELETE',
          headers
        });
        
        if (!res.ok) throw new Error('فشل إزالة الحظر');
        
        alert('تم إزالة الحظر بنجاح.');
        fetchBlockedUsers();
      } catch (err) {
        alert('خطأ: ' + err.message);
      }
    }

    async function blockCurrentChatUser() {
      if (!selectedChatPhone) return;
      
      const reason = prompt("تأكيد حظر العميل نهائياً من الخدمة؟\nاكتب سبب الحظر (اختياري):");
      if (reason === null) return; // User cancelled

      try {
        const res = await fetch(`/api/shop/chats/${encodeURIComponent(selectedChatPhone)}/block`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason })
        });
        
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'فشل الحظر');
        }

        alert('تم حظر العميل بنجاح ولن يتمكن من التواصل مع البوت مجدداً.');
        closeChatView();
        fetchChatList();
      } catch (err) {
        alert('خطأ: ' + err.message);
      }
    }

    function openStripeGuideModal() {
      document.getElementById('stripeGuideModal').style.display = 'flex';
    }

    function closeStripeGuideModal() {
      document.getElementById('stripeGuideModal').style.display = 'none';
    }

    function openWaGuideModal() {
      document.getElementById('waGuideModal').style.display = 'flex';
    }

    function closeWaGuideModal() {
      document.getElementById('waGuideModal').style.display = 'none';
    }

    function logout() {
      if (chatPollInterval) clearInterval(chatPollInterval);
      localStorage.clear();
      window.location.href = '/login';
    }
  