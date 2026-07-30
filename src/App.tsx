import { useStore } from './store'
import Header from './components/Header'
import UploadZone from './components/UploadZone'
import ProcessingView from './components/ProcessingView'
import EditorView from './components/EditorView'
import ExportView from './components/ExportView'

export default function App() {
  const step = useStore((s) => s.step)

  return (
    <div className="h-full flex flex-col bg-slate-900">
      <Header />
      <main className="flex-1 flex flex-col overflow-hidden">
        {step === 'upload' && <UploadZone />}
        {step === 'processing' && <ProcessingView />}
        {step === 'editor' && <EditorView />}
        {step === 'export' && <ExportView />}
      </main>
    </div>
  )
}
