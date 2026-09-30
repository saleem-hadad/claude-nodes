import { useEffect, useRef } from 'react'
import { Modal } from '../Modal'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

/** A small macOS-style alert. Enter confirms and Escape cancels. */
export function ConfirmDialog({ request }: { request: ConfirmRequest | null }) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (request) confirmRef.current?.focus()
  }, [request])

  if (!request) return null
  const cancel = () => request.resolve(false)

  return (
    <Modal open onClose={cancel} className="confirm-dialog" labelledBy="confirm-title">
      <h2 id="confirm-title" className="confirm-title">
        {request.title}
      </h2>
      <p className="confirm-message">{request.message}</p>
      <div className="confirm-actions">
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          className={request.danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={() => request.resolve(true)}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
