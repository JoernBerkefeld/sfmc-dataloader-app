'use strict';

// Native dialog supplies modal semantics and focus containment; content is text-only.
(function initChangelog(globalObject) {
    const { element, toast } = globalObject.McUI;

    /**
     * Queues update notes after consent and active work, without stacking dialogs.
     *
     * @returns {Promise.<void>}
     */
    async function init() {
        let notes;
        try {
            notes = await globalObject.mcdata.getChangelog();
        } catch {
            return;
        }
        if (!notes?.pending) {
            return;
        }
        let activeJob;
        let isShown = false;
        const observer = new MutationObserver(tryShow);
        observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['open'],
        });
        const unsubscribe = globalObject.JobRunner.subscribeActive((job) => {
            activeJob = job;
            tryShow();
        });
        tryShow();

        /**
         * Presents only while idle; no network, installation, or transfer actions are performed.
         *
         * @returns {void}
         */
        function tryShow() {
            if (isShown || activeJob || document.querySelector('dialog[open]')) {
                return;
            }
            isShown = true;
            observer.disconnect();
            // The immediate subscription callback may run before unsubscribe is assigned.
            queueMicrotask(() => unsubscribe());
            show(notes);
        }
    }

    /**
     * Displays release sections and optional full bundled history using textContent only.
     *
     * @param {object} notes
     * @returns {void}
     */
    function show(notes) {
        const previousFocus = document.activeElement;
        const dialog = element('dialog', {
            class: 'modal changelog-modal',
            attrs: { 'aria-labelledby': 'changelog-title' },
        });
        const heading = element('h2', {
            text: `What's new in v${notes.currentVersion}`,
            attrs: { id: 'changelog-title' },
        });
        const close = globalObject.McForms.button('Close changelog');
        const content = element('div', {
            class: 'changelog-content',
            attrs: { tabindex: '0', 'aria-label': 'Release notes' },
        });
        const status = element('p', { attrs: { role: 'status' } });
        const appendSections = (target, sections) => {
            for (const section of sections) {
                target.append(
                    element('h3', { text: `Version ${section.version}` }),
                    element('pre', { class: 'changelog-text', text: section.text }),
                );
            }
        };
        appendSections(content, notes.sections);
        const history = element('details');
        history.append(element('summary', { text: 'Bundled release history' }));
        appendSections(history, notes.history);
        content.append(history);
        dialog.append(heading, content, status, close);
        document.body.append(dialog);
        let isSaving = false;
        const dismiss = async () => {
            if (isSaving) {
                return;
            }
            isSaving = true;
            close.disabled = true;
            try {
                const result = await globalObject.mcdata.acknowledgeChangelog();
                if (!result?.saved) {
                    toast('Changelog dismissal could not be saved; notes may appear next launch.');
                }
            } catch {
                toast('Changelog dismissal could not be saved; notes may appear next launch.');
            }
            dialog.close();
        };
        close.addEventListener('click', dismiss);
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            void dismiss();
        });
        dialog.addEventListener(
            'close',
            () => {
                dialog.remove();
                if (previousFocus?.isConnected) {
                    previousFocus.focus();
                }
            },
            { once: true },
        );
        dialog.showModal();
        close.focus();
    }

    globalObject.McChangelog = { init };
})(globalThis);
