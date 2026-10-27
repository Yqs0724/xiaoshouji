    const hold = document.getElementById("btnChatHold");
    if (hold) {
      hold.addEventListener("contextmenu", (e) => e.preventDefault());
      hold.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        beginVoiceHold(hold);
      });
      const endHold = () => {
        if (!voiceHold && !hold.classList.contains("is-pressing")) return;
        endVoiceHold(hold);
      };
      hold.addEventListener("pointerup", endHold);
      hold.addEventListener("pointerleave", endHold);
      hold.addEventListener("pointercancel", endHold);
    }