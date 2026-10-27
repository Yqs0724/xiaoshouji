        const scopeBtn = e.target.closest("[data-mom-scope]");
        if (scopeBtn) {
          await toggleMomentScopeUi(scopeBtn.getAttribute("data-mom-scope"));
          return;
        }