        const scopeBtn = e.target.closest("[data-mom-scope]");
        if (scopeBtn) {
          openMomentScopeUi(scopeBtn.getAttribute("data-mom-scope"));
          return;
        }