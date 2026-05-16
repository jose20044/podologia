/**
 * Cliente API PodoClinic
 * Funciones auxiliares para interactuar con la API
 */

const API_URL = 'https://podologia-production-0157.up.railway.app';

class PodoClinicAPI {
  constructor() {
    this.token = localStorage.getItem('authToken');
    this.user = JSON.parse(localStorage.getItem('currentUser') || '{}');
  }

  /**
   * AUTENTICACIÓN
   */

  async login(email, password) {
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      
      if (data.success) {
        this.token = data.token;
        this.user = data.user;
        localStorage.setItem('authToken', this.token);
        localStorage.setItem('currentUser', JSON.stringify(this.user));
      }
      
      return { success: data.success, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async register(name, email, password) {
    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const data = await res.json();
      return { success: data.success, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * PACIENTES
   */

  async getPacientes() {
    try {
      const res = await fetch(`${API_URL}/pacientes`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return res.ok ? await res.json() : [];
    } catch (error) {
      console.error('Error obteniendo pacientes:', error);
      return [];
    }
  }

  async createPaciente(datos) {
    try {
      const res = await fetch(`${API_URL}/pacientes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(datos)
      });
      const data = await res.json();
      return { success: res.ok, id: data.id, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updatePaciente(id, datos) {
    try {
      const res = await fetch(`${API_URL}/pacientes/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(datos)
      });
      return { success: res.ok };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deletePaciente(id) {
    try {
      const res = await fetch(`${API_URL}/pacientes/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return { success: res.ok };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * CITAS
   */

  async getCitas(fecha = '') {
    try {
      const url = fecha ? `${API_URL}/citas?fecha=${encodeURIComponent(fecha)}` : `${API_URL}/citas`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return res.ok ? await res.json() : [];
    } catch (error) {
      console.error('Error obteniendo citas:', error);
      return [];
    }
  }

  async createCita(datos) {
    try {
      const res = await fetch(`${API_URL}/citas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(datos)
      });
      const data = await res.json();
      return { success: res.ok, id: data.id, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updateCita(id, datos) {
    try {
      const res = await fetch(`${API_URL}/citas/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(datos)
      });
      const data = await res.json();
      return { success: res.ok, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteCita(id) {
    try {
      const res = await fetch(`${API_URL}/citas/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      const data = await res.json();
      return { success: res.ok, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * HISTORIAL CLÍNICO
   */

  async getHistorial(pacienteId) {
    try {
      const res = await fetch(`${API_URL}/historial/${pacienteId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return res.ok ? await res.json() : [];
    } catch (error) {
      console.error('Error obteniendo historial:', error);
      return [];
    }
  }

  async crearEntradaHistorial(datos) {
    try {
      const res = await fetch(`${API_URL}/historial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(datos)
      });
      const data = await res.json();
      return { success: res.ok, id: data.id, error: data.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * TRATAMIENTOS
   */

  async getTratamientos() {
    try {
      const res = await fetch(`${API_URL}/tratamientos`);
      return res.ok ? await res.json() : [];
    } catch (error) {
      console.error('Error obteniendo tratamientos:', error);
      return [];
    }
  }

  /**
   * UTILIDADES
   */

  isAuthenticated() {
    return !!this.token && !!this.user.id;
  }

  logout() {
    this.token = null;
    this.user = {};
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
  }

  /**
   * CONVERSIÓN DE DATOS
   */

  formatearFecha(date) {
    return new Date(date).toLocaleDateString('es-CL');
  }

  formatearPrecio(precio) {
    return new Intl.NumberFormat('es-CL', {
      style: 'currency',
      currency: 'CLP'
    }).format(precio);
  }
}

// Instancia global
const api = new PodoClinicAPI();

// Ejemplo de uso:
/*
// Login
const result = await api.login('correo@example.com', 'password123');
if (result.success) {
  console.log('✅ Autenticado');
}

// Obtener pacientes
const pacientes = await api.getPacientes();
console.log(pacientes);

// Crear paciente
const nuevo = await api.createPaciente({
  nombre: 'Juan Pérez',
  rut: '12.345.678-9',
  edad: 45,
  email: 'juan@email.com'
});

// Obtener historial
const historial = await api.getHistorial(1);
console.log(historial);

// Crear entrada clínica
const entrada = await api.crearEntradaHistorial({
  paciente_id: 1,
  tratamiento: 'Quiropodia básica',
  diagnostico: 'Callosidades en talones',
  observaciones: 'Procedimiento exitoso'
});

// Logout
api.logout();
*/
